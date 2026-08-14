/**
 * How this repo authenticates to mdrag — credential and destination, together.
 *
 * mdrag admits a caller two ways from here, and *which one* decides where the
 * call may be aimed:
 *
 * - **vouch** — `X-Internal-Secret` + `X-User-Email`, one of our own services
 *   stating who it is acting for. mdrag trusts the email only on a tokenless
 *   request, which its middleware admits only behind the secret (ADR 0033).
 * - **token** — a `dc_` JWT the caller holds. Names its own owner via the
 *   `email` claim; no header needed, and nothing strips it.
 *
 * ## The destination rule, and why it is not "never use the wiki"
 *
 * `wiki.datacrew.space/api/v1/*` terminates at mdrag's own Next.js proxy, where
 * `x-internal-secret` and `x-user-email` are PROXY_TRUST_HEADERS: stripped from
 * every inbound request and re-injected only when the proxy vouches — which it
 * does only for a caller with no credentials of its own. A server-to-server
 * caller has no NextAuth session to be vouched from, so a **vouching** call
 * routed there loses its identity and every user arrives as the same nobody,
 * silently, with a 200. Diagnosed the hard way in #36.
 *
 * A **token** call to that same host is fine — tokens are not proxy-trust
 * headers and pass straight through. `mdrag-primitives` and `report-mdrag`
 * depend on exactly that, which is why this rule is scoped to the credential
 * rather than applied to the hostname outright. A blanket ban would have been
 * simpler and wrong.
 *
 * #67 removed the wiki default from the conversation resolver. That stopped the
 * accident but not the mistake: `MDRAG_URL` can still be *set* to that host, and
 * nothing noticed. Here it cannot reach a vouching call at all.
 *
 * ## The cases are shared, not restated
 *
 * `contracts/trusted-hop-cases.json` is vendored from mdrag, which owns it, and
 * `mdrag-hop.test.ts` drives this module from it. mdrag's own suite and the
 * wiki's frontend read the same table, so "the three agree" is checked. The
 * vendored copy is verified byte-identical against the upstream file whenever
 * both are on disk (the umbrella checkout); see the test for what that cannot
 * cover.
 */

/** Hosts that strip the vouching headers. Aiming a vouch at one is never right. */
export const STRIPPING_HOSTS = new Set(["wiki.datacrew.space"]);

/** Refusal to build a call. Never a transient failure — do not retry one. */
export class MdragHopError extends Error {}

export type MdragCredential =
  | { kind: "vouch"; internalSecret: string; userEmail: string }
  | { kind: "token"; token: string };

export type MdragCall = {
  url: string;
  headers: Record<string, string>;
  /** Which credential was used. Callers log this; mdrag resolves identity differently per mode. */
  authMode: "internal_secret" | "token";
  /** The end user this call acts for, when the credential names one. */
  userEmail?: string;
};

/**
 * Pick the credential from the environment, preferring the more specific one.
 *
 * A vouch needs both halves: the secret AND someone to vouch for. `X-User-Email`
 * on its own is not a credential — mdrag rejects a tokenless `/api/v1` request
 * without the secret — so a half-configured vouch falls through to the token
 * rather than being sent as a weaker form of auth.
 *
 * @param userEmail The end user to act for, when there is one.
 * @throws MdragHopError when neither credential is available.
 */
export function mdragCredentialFromEnv(userEmail?: string): MdragCredential {
  const internalSecret = (process.env.MDRAG_INTERNAL_SECRET ?? "").trim();
  const email = (userEmail ?? "").trim();
  if (internalSecret && email) {
    return { kind: "vouch", internalSecret, userEmail: email };
  }

  const token = (process.env.MDRAG_TOKEN ?? "").trim();
  if (token) {
    return { kind: "token", token };
  }

  throw new MdragHopError(
    "mdrag auth not configured: set MDRAG_TOKEN, or set MDRAG_INTERNAL_SECRET " +
      "and pass the end user's email to vouch for"
  );
}

/**
 * Where mdrag is. No default, because the only plausible-looking one is the host
 * that breaks a vouching call.
 *
 * Resolved per call rather than at module load: this module is imported
 * transitively by tasks that never touch mdrag, and throwing at import would
 * take those down over a variable they do not use. Failing here still fails on
 * the first request that actually needs it, which is the moment that matters.
 *
 * @throws MdragHopError when `MDRAG_URL` is unset.
 */
export function mdragBaseUrl(): string {
  const raw = (process.env.MDRAG_URL ?? "").trim();
  if (!raw) {
    throw new MdragHopError(
      "MDRAG_URL is required and has no default. Set it to mdrag's DIRECT " +
        "address (on bonker: http://mdrag-local:8017)."
    );
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Build one authenticated call to mdrag: URL and headers, or neither.
 *
 * @param path Absolute API path, e.g. `/api/v1/conversations/`.
 * @param credential What to present. See {@link mdragCredentialFromEnv}.
 * @param baseUrl Destination override; defaults to {@link mdragBaseUrl}.
 * @throws MdragHopError when a vouching call is aimed at a stripping host.
 */
export function mdragCall(
  path: string,
  credential: MdragCredential,
  baseUrl?: string
): MdragCall {
  const base = (baseUrl ?? mdragBaseUrl()).replace(/\/+$/, "");
  const url = `${base}/${path.replace(/^\/+/, "")}`;

  if (credential.kind === "vouch") {
    assertVouchReaches(base);
    return {
      url,
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": credential.internalSecret,
        "X-User-Email": credential.userEmail,
      },
      authMode: "internal_secret",
      userEmail: credential.userEmail,
    };
  }

  return {
    url,
    headers: {
      "Content-Type": "application/json",
      // `Authorization: Bearer`, not `X-DC-Token`. Live-verified 2026-08-12: a
      // valid token sent as X-DC-Token clears mdrag's admission gate, but
      // /me/resources/resolve and /conversations/ resolve identity through
      // get_current_user, which at the time read Authorization first and
      // X-User-Email second — X-DC-Token was not in that check at all, so every
      // such call resolved anonymous regardless of whose token it was. mdrag has
      // since unified the two locations (ADR 0033), and this stays as written
      // because it is the location that was actually verified end to end.
      Authorization: `Bearer ${credential.token}`,
    },
    authMode: "token",
  };
}

/**
 * Throw when a vouching call is aimed at a host that strips its headers.
 *
 * Compared on the parsed hostname, not a substring: a port, a path, or a
 * difference in case must not slip past. A check that matches one spelling is a
 * comment with extra steps.
 */
function assertVouchReaches(base: string): void {
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    throw new MdragHopError(`not an absolute URL: ${base}`);
  }
  if (STRIPPING_HOSTS.has(host)) {
    throw new MdragHopError(
      `${host} strips X-Internal-Secret and X-User-Email from inbound requests ` +
        "by design, so this call would succeed with no identity and every user " +
        "would arrive as the same nobody. Address mdrag directly instead (on " +
        "bonker: http://mdrag-local:8017). A TOKEN call to this host is fine — " +
        "tokens are not stripped."
    );
  }
}
