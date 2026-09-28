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
export async function checkLiveness(
  value: string,
  fetchImpl: typeof fetch = fetch,
  url: string = DEFAULT_LIVENESS_URL
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
    return "unknown";
  } catch {
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
