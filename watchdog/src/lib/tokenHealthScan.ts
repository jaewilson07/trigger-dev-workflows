/**
 * The Infisical-facing IO for the token-health watchdog
 * (`../trigger/tokenHealthReport.ts`): secret listing and the dead-since
 * state round-trip. The liveness probe lives in `./tokenHealthLiveness.ts`
 * instead — it has no `@datacrew/trigger-shared` import, so it (unlike this
 * file) can run under watchdog's plain `tsc`-then-`node --test` harness. See
 * that file's doc comment for why the split exists.
 */

import { getSecret, listAllSecrets, setSecret, type SecretEntry } from "@datacrew/trigger-shared";
import type { SecretRecord } from "./tokenHealthCore.js";

export { checkLiveness, checkLivenessForGroups } from "./tokenHealthLiveness.js";

/** Folders to sweep. `/` recursive would also work, but scoping to the two
 * folders that are documented to ever hold a dc_/mat_ value keeps this from
 * silently growing scope to every app's secrets the moment a third exists. */
export const SCAN_PATHS = ["/datacrew", "/mdrag"] as const;
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

/** `{}` when no state has ever been written (first run). */
export async function loadDeadSinceState(
  getImpl: typeof getSecret = getSecret
): Promise<Record<string, string>> {
  try {
    const raw = await getImpl(STATE_KEY, { path: STATE_PATH, recursive: false });
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function saveDeadSinceState(
  state: Record<string, string>,
  setImpl: typeof setSecret = setSecret
): Promise<void> {
  await setImpl(STATE_KEY, JSON.stringify(state), { path: STATE_PATH, mode: "upsert" });
}
