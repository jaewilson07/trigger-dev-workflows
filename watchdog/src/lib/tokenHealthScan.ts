/**
 * The Infisical-facing IO for the token-health watchdog
 * (`../trigger/tokenHealthReport.ts`): secret listing and the dead-since
 * state round-trip. The liveness probe lives in `./tokenHealthLiveness.ts`
 * instead — it has no `@datacrew/trigger-shared` import, so it (unlike this
 * file) can run under watchdog's plain `tsc`-then-`node --test` harness. See
 * that file's doc comment for why the split exists.
 */

import { logger } from "@trigger.dev/sdk";
import { getSecret, listAllSecrets, setSecret, type SecretEntry } from "@datacrew/trigger-shared";
import type { SecretRecord } from "./tokenHealthCore.js";

export { checkLiveness, checkLivenessForGroups } from "./tokenHealthLiveness.js";

/** Folders to sweep. Scoped to `["/datacrew", "/mdrag"]` until 2026-09-28,
 * when a review found live dc_/mat_ tokens also sitting in `/alix`
 * (`LETTA_GATEWAY_TOKEN`), `/bid-buddy` (`BID_BUDDY_MDRAG_ACCESS_TOKEN`), and
 * `/letta-shim` (`LETTA_SHIM_INTERNAL_SECRET`) — all three answering 200 on
 * the liveness check, i.e. real tokens this watchdog was silently not
 * scanning. Scan the whole project recursively instead: `trackSecrets`
 * already filters every record down to dc_/mat_ values afterward, so
 * widening the folder list adds no noise, only coverage. */
export const SCAN_PATHS = ["/"] as const;
export const SCAN_ENVIRONMENTS = ["prod", "dev"] as const;

const PROJECT_ID = "3fbb4296-d4e6-4c17-83ee-b852a57a5e50";
const STATE_PATH = "/datacrew";
const STATE_KEY = "TOKEN_HEALTH_DEAD_SINCE_STATE";

/** Fetches every secret under every scanned path/environment. Callers filter to dc_/mat_ afterward. */
export async function fetchAllSecretRecords(
  listImpl: (opts: {
    path?: string;
    environment?: string;
    projectId?: string;
    recursive?: boolean;
  }) => Promise<SecretEntry[]> = listAllSecrets
): Promise<SecretRecord[]> {
  const records: SecretRecord[] = [];
  for (const environment of SCAN_ENVIRONMENTS) {
    for (const path of SCAN_PATHS) {
      const entries = await listImpl({ path, environment, projectId: PROJECT_ID, recursive: true });
      for (const entry of entries) {
        records.push({
          name: entry.name,
          path: entry.path,
          environment: entry.environment,
          value: entry.value,
          rawValue: entry.rawValue,
        });
      }
    }
  }
  return records;
}

/**
 * `{}` when no state has ever been written (first run) — but also `{}`, with
 * a warning logged first, when the read/parse itself fails (e.g. Infisical
 * outage, corrupt JSON). House rule: never swallow a caught error silently.
 * `logImpl` defaults to the trigger.dev `logger`; tests inject a fake so the
 * `node --test` harness this file documents itself as sitting outside of
 * (see the file-level doc comment) still exercises the log-vs-no-log branch
 * without a real logger context. Never logs the raw error or state value.
 */
export async function loadDeadSinceState(
  getImpl: typeof getSecret = getSecret,
  logImpl: (message: string) => void = (message) => logger.warn(message)
): Promise<Record<string, string>> {
  try {
    const raw = await getImpl(STATE_KEY, { path: STATE_PATH, recursive: false });
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    logImpl(
      "token-health-report: could not read/parse dead-since state; treating as empty (dead-since dates will restart from now)"
    );
    return {};
  }
}

export async function saveDeadSinceState(
  state: Record<string, string>,
  setImpl: typeof setSecret = setSecret
): Promise<void> {
  await setImpl(STATE_KEY, JSON.stringify(state), { path: STATE_PATH, mode: "upsert" });
}
