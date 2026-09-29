/**
 * The liveness half of `./tokenHealthScan.ts`, split out because it has no
 * dependency on `@datacrew/trigger-shared` — unlike the Infisical-facing
 * half (`fetchAllSecretRecords`/`loadDeadSinceState`/`saveDeadSinceState`),
 * which imports that package's raw `.ts` source (its `main` points at
 * `src/index.ts`, resolved by trigger.dev's bundler at deploy time, not by
 * plain `node --test`) and so cannot be part of watchdog's ad-hoc
 * `tsc`-then-`node --test` harness. `checkLiveness`/`checkLivenessForGroups`
 * take only a plain `fetch`, so they can live here and be exercised directly
 * — same split `failureAlertReporter.ts`/`failureAlertFetch.ts` already use
 * for the same reason (see that file's doc comment).
 */

import { logger } from "@trigger.dev/sdk";
import type { LivenessStatus, ValueGroup } from "./tokenHealthCore.js";

const DEFAULT_LIVENESS_URL = process.env.MDRAG_API_URL
  ? `${process.env.MDRAG_API_URL.replace(/\/+$/, "")}/api/v1/users/me`
  : "https://wiki.datacrew.space/api/v1/users/me";
const REQUEST_USER_AGENT = "datacrew-watchdog-token-health";

/**
 * `GET /api/v1/users/me` against mdrag — live-verified 2026-09-28 to answer
 * 200 for a good `mat_`/`dc_` token and 401 for a dead one, for BOTH the
 * direct bonker host and the public `wiki.datacrew.space` proxy (which
 * forwards `Authorization` untouched — see `mdrag-hop.ts`'s doc comment on
 * which headers that proxy strips; `Authorization` is not one of them).
 */
/**
 * `logImpl` defaults to the trigger.dev `logger` and fires only on the
 * "unknown" branches (unexpected status, network/fetch failure) — never on
 * `dead`/`live`, which are unremarkable outcomes. It surfaces the error
 * class/message so `unknownEntries` in the report is diagnosable instead of
 * a bare "unknown", but NEVER the token `value` itself. Tests inject a fake
 * to assert on this without a real logger context.
 */
export async function checkLiveness(
  value: string,
  fetchImpl: typeof fetch = fetch,
  url: string = DEFAULT_LIVENESS_URL,
  logImpl: (message: string, meta?: Record<string, unknown>) => void = (message, meta) =>
    logger.warn(message, meta)
): Promise<LivenessStatus> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${value}`,
        "User-Agent": REQUEST_USER_AGENT,
      },
    });
    if (res.status === 401) return "dead";
    if (res.ok) return "live";
    // Any other status (403, 500, ...) is not a positive statement the token
    // is dead — report it as unknown rather than a false alert.
    logImpl("token-health: liveness check returned an unexpected status", { status: res.status });
    return "unknown";
  } catch (error) {
    logImpl("token-health: liveness check failed (network/fetch error)", {
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return "unknown";
  }
}

/** Checks each distinct value exactly once (per `groupByValue`'s dedup). */
export async function checkLivenessForGroups(
  groups: ValueGroup[],
  checkImpl: (value: string) => Promise<LivenessStatus> = (value) => checkLiveness(value)
): Promise<Map<string, LivenessStatus>> {
  const result = new Map<string, LivenessStatus>();
  for (const group of groups) {
    result.set(group.value, await checkImpl(group.value));
  }
  return result;
}
