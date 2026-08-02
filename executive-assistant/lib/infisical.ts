/**
 * Runtime secret retrieval from the self-hosted Infisical at
 * `infisical.datacrew.space`.
 *
 * WHY RUNTIME AND NOT A TRIGGER.DEV ENV VAR. Every new secret otherwise means
 * a manual write into the trigger.dev environment, where it then lives as a
 * second copy that drifts from Infisical silently. Fetching at runtime means
 * ONE bootstrap pair (`INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET`) is
 * the only thing trigger.dev has to hold, and every other secret is read from
 * the source of truth on each run.
 *
 * This duplicates `watchdog/src/trigger/infraHealthReport.ts`'s Infisical
 * helpers rather than importing them. The two projects are separate
 * trigger.dev deploys with separate bundles, and a shared workspace package
 * would be resolved by trigger.dev's esbuild bundler at deploy time -- an
 * open question flagged in datacrew's ADR-003 and not something to discover
 * on the path that fetches credentials. Worth revisiting once a `file:`
 * workspace dep is proven to deploy; until then, if you change the auth flow
 * here, change it there too.
 *
 * NOTE ON THE CF-ACCESS PROXY. `infra-bonker/.github/skills/
 * infisical-retrieve-secrets.md` says `infisical.datacrew.space` is gated by
 * Cloudflare Access and scripts must go through a local proxy on :8082. That
 * is STALE as of 2026-08-01: the host answers `GET /api/status` with a plain
 * 200 and no redirect, and no `cf-access-proxy` unit exists on bonker. Direct
 * HTTPS is correct; do not reintroduce the proxy hop.
 */

const INFISICAL_PROJECT_ID =
  process.env.INFISICAL_PROJECT_ID ?? "3fbb4296-d4e6-4c17-83ee-b852a57a5e50";
const INFISICAL_ENVIRONMENT = process.env.INFISICAL_ENVIRONMENT ?? "prod";
// Recursive from ROOT, deliberately NOT watchdog's "/datacrew". Verified
// 2026-08-01: this project keeps secrets in per-app top-level folders
// (/letta, /mdrag, /paperclip, /alix, /claude-slack, /datacrew, ...), and
// LETTA_API_KEY lives in /letta. A recursive read from /datacrew returns 50
// secrets and does not include it; from / it returns 277 and does. Since the
// machine identity can already read all of them, scoping the read narrower
// buys no access control -- only a confusing "secret not found" for anything
// outside the guessed folder. Overridable so a caller that knows its folder
// can narrow the fetch.
const INFISICAL_SECRET_PATH = process.env.INFISICAL_SECRET_PATH ?? "/";

function baseUrl(): string {
  return (process.env.INFISICAL_API_URL ?? "https://infisical.datacrew.space").replace(/\/$/, "");
}

/** True when the bootstrap machine-identity pair is present. */
export function isInfisicalConfigured(): boolean {
  return Boolean(process.env.INFISICAL_CLIENT_ID && process.env.INFISICAL_CLIENT_SECRET);
}

async function fetchAccessToken(): Promise<string> {
  const res = await fetch(`${baseUrl()}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      clientId: process.env.INFISICAL_CLIENT_ID,
      clientSecret: process.env.INFISICAL_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Infisical auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) {
    throw new Error("Infisical auth response missing accessToken");
  }
  return data.accessToken;
}

// One token and one secret listing per process. Tasks are short-lived, and
// re-authenticating per secret would turn a two-secret task into four round
// trips against the credential store.
let cachedSecrets: Promise<Map<string, string>> | null = null;

async function loadSecrets(): Promise<Map<string, string>> {
  const token = await fetchAccessToken();
  const url = new URL(`${baseUrl()}/api/v3/secrets/raw`);
  url.searchParams.set("workspaceId", INFISICAL_PROJECT_ID);
  url.searchParams.set("environment", INFISICAL_ENVIRONMENT);
  url.searchParams.set("secretPath", INFISICAL_SECRET_PATH);
  url.searchParams.set("recursive", "true");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Infisical fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    secrets?: Array<{ secretKey?: string; secretValue?: string }>;
  };
  const map = new Map<string, string>();
  for (const item of data.secrets ?? []) {
    if (item.secretKey && item.secretValue) {
      // Strip wrapping quotes: dotenv-style values round-trip through
      // Infisical with them intact, and a quoted API key fails auth in a way
      // that looks like a bad credential rather than a formatting problem.
      map.set(item.secretKey, item.secretValue.trim().replace(/^['"]|['"]$/g, ""));
    }
  }
  return map;
}

/**
 * Resolve a secret, preferring an explicit env var over Infisical.
 *
 * The env-var check comes first so local `trigger dev` and tests keep working
 * without machine-identity credentials, and so an operator can always
 * override a value in an incident without touching the secret store.
 *
 * Returns null rather than throwing when the secret cannot be resolved --
 * callers here treat an unconfigured fallback as "not available" and
 * propagate their own original error, which is more useful than an Infisical
 * stack trace masking, say, a gateway outage.
 */
export async function getSecret(name: string): Promise<string | null> {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  if (!isInfisicalConfigured()) return null;

  cachedSecrets ??= loadSecrets();
  try {
    return (await cachedSecrets).get(name) ?? null;
  } catch (error) {
    // Reset so a transient auth/network failure doesn't poison the process
    // for its whole lifetime.
    cachedSecrets = null;
    throw error;
  }
}
