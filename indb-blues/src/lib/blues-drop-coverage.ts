import { logger } from "@trigger.dev/sdk";
import { mdragCall, type MdragCredential } from "@datacrew/trigger-shared";
import type { BluesDropCoverage } from "./blues-drop-types.js";

/**
 * Industry-coverage research for the Blues Drop of the Week
 * (trigger-dev-workflows#100): at least one source article + short summary
 * for the week's topic, via mdrag's `POST /api/v1/primitives/search-providers`
 * — the "search_web equivalent" this issue names. `executive-assistant/lib/
 * mdrag-primitives.ts`'s own docstring documents the migration this mirrors:
 * "Topic search … now goes through this same client (via search-providers)
 * rather than the old FastMCP search_web path."
 *
 * ## Credential mode — TOKEN, never vouch
 *
 * `@datacrew/trigger-shared`'s `mdrag-hop.ts` documents two credential
 * modes. This module ALWAYS builds a `{ kind: "token" }` credential
 * directly — never `mdragCredentialFromEnv()`, which would prefer a vouch
 * over a token if `MDRAG_INTERNAL_SECRET` ever happened to be set in this
 * project's environment. indb-blues is a server-to-server caller with no
 * end user to vouch for, and `mdrag-hop.ts`'s own module docstring documents
 * exactly why a vouching call must never be aimed at `wiki.datacrew.space`:
 * that host's proxy strips `X-Internal-Secret`/`X-User-Email` by design, so
 * a vouching call there loses its identity and every user arrives as the
 * same nobody, silently, with a 200 (diagnosed the hard way in mdrag#36). A
 * TOKEN call to that same host is fine — tokens are not proxy-trust headers
 * and pass straight through — which is what lets this default to the public
 * `wiki.datacrew.space` host: this project's ephemeral trigger.dev
 * containers have no route to the bonker-internal `mdrag-local:8017`
 * address a same-network caller would use instead.
 *
 * `provider: "web"` (SearxNG), not `"youtube"` — mdrag's own `youtube`
 * Provider was tried live for this issue and currently 502s server-side, a
 * pre-existing mdrag-side gap unrelated to this repo (see
 * `blues-drop-youtube.ts`'s module docstring, and this PR's description).
 *
 * ## Failure contract
 *
 * Never throws. No configured token, `mdragCall` refusing to build the
 * request (a vouch aimed at a stripping host — cannot happen here since this
 * module never builds a vouch), a non-2xx response, or zero results are all
 * `null` — an explicit "no coverage found" result, matching this repo's
 * `skipped`-is-a-result vocabulary applied to a research source. Same
 * contract as `blues-drop-youtube.ts`.
 */

const DEFAULT_MDRAG_URL = "https://wiki.datacrew.space";
const REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_PROVIDER = "web";

type SearchProvidersResult = {
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
};

/**
 * @param query Free-text query for the week's topic.
 * @param token The mdrag `dc_` token (`DATACREW_API_TOKEN` in Infisical), or
 * `null`/empty/undefined when none is configured — treated as "skip".
 * @param baseUrl Override for tests; defaults to the `MDRAG_URL` env var,
 * then the public wiki host (see module docstring for why that default is
 * safe for a TOKEN call specifically — it would NOT be for a vouch).
 */
export async function searchBluesDropCoverage(
  query: string,
  token: string | null | undefined,
  baseUrl?: string
): Promise<BluesDropCoverage | null> {
  if (!token) {
    logger.info("research-coverage: skipped — no mdrag token configured", { query });
    return null;
  }

  const credential: MdragCredential = { kind: "token", token };
  const resolvedBase = baseUrl ?? process.env.MDRAG_URL ?? DEFAULT_MDRAG_URL;

  let call: ReturnType<typeof mdragCall>;
  try {
    call = mdragCall("/api/v1/primitives/search-providers", credential, resolvedBase);
  } catch (error) {
    // MdragHopError — a refusal to build the call (e.g. a vouch aimed at a
    // stripping host). Not a transient failure and, per mdrag-hop.ts's own
    // doc comment, not something to retry — but still just "no coverage"
    // from this task's perspective, not a reason to fail the whole research
    // step.
    logger.warn("research-coverage: refused to build mdrag call, treating as no coverage", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  try {
    const res = await fetch(call.url, {
      method: "POST",
      headers: call.headers,
      body: JSON.stringify({
        provider: SEARCH_PROVIDER,
        available_providers: [SEARCH_PROVIDER],
        text: query,
        limit: 3,
        hydrate: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("research-coverage: mdrag search-providers returned a non-2xx status", {
        status: res.status,
        authMode: call.authMode,
        body: body.slice(0, 500),
      });
      return null;
    }

    const data = (await res.json()) as SearchProvidersResult;
    const hit = data.results?.find((r) => r.url && r.title);
    if (!hit || !hit.url || !hit.title) {
      logger.info("research-coverage: no source found", { query });
      return null;
    }

    return {
      title: hit.title,
      url: hit.url,
      summary: hit.snippet ?? "",
    };
  } catch (error) {
    logger.warn("research-coverage: request failed, treating as no coverage", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
