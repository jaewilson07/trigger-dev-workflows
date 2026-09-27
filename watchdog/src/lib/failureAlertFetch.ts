/**
 * The one function in the failure-alert path that needs
 * `@datacrew/trigger-shared` (`getTriggerSecretKey`) — split into its own
 * file, separate from `failureAlertReporter.ts`, so that file (and its
 * tests) stay on relative-only imports. `@datacrew/trigger-shared`'s
 * package.json points `main` at raw `./src/index.ts` (fine for the actual
 * esbuild-based Trigger.dev build, which handles `.ts` directly) but breaks
 * watchdog's own `tsc`-then-`node --test` unit-test harness, which runs
 * plain compiled `.js` — `node --test` cannot `import` a `.ts` file
 * (`ERR_UNKNOWN_FILE_EXTENSION`). No other watchdog `lib/*.ts` file under
 * test imports an `@datacrew/*` package for the same reason (see
 * `vendorDocsMirror.ts` vs. `vendorDocsMirrorCore.ts`'s split) — this file
 * follows that precedent instead of fighting it, and is intentionally NOT
 * in `package.json`'s `test` file list (see `failureAlertReport.ts`, its
 * only caller, for how the fake-free real path wires together).
 */

import { getTriggerRun, getTriggerSecretKey } from "@datacrew/trigger-shared";
import type { RawRun } from "./failureAlertCore.js";

const TRIGGER_API_BASE_URL = (process.env.TRIGGER_API_URL ?? "https://triggers.datacrew.space").replace(/\/+$/, "");

/**
 * Same endpoint/params `scripts/trigger-deadman.mjs` already uses in
 * production (`GET /api/v1/runs?limit=500&after=<ISO date>`), against
 * `projectKey`'s OWN per-project secret key — a project's Trigger.dev
 * secret key only ever sees that project's own runs, which is exactly why
 * `runFailureAlertSweep` loops over all three `MONITORED_PROJECTS` rather
 * than making one call.
 *
 * NOTE: the exact shape of a list-run item (particularly `error`) is not
 * verified against a live call in this change — `extractRunError` in
 * `failureAlertCore.ts` is written defensively for that reason.
 */
export async function fetchRunsForProject(projectKey: string, windowStart: Date): Promise<RawRun[]> {
  const secretKey = await getTriggerSecretKey(projectKey);
  const res = await fetch(`${TRIGGER_API_BASE_URL}/api/v1/runs?limit=500&after=${windowStart.toISOString()}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`fetchRunsForProject(${projectKey}): GET /api/v1/runs failed with ${res.status}`);
  }
  const data = (await res.json()) as { data?: RawRun[] };
  return data.data ?? [];
}

/**
 * Run detail — `GET /api/v3/runs/{runId}` — for the one field the list
 * endpoint above doesn't carry: `error`. Reuses `getTriggerRun` from
 * `@datacrew/trigger-shared` (same auth: `getTriggerSecretKey` + Bearer,
 * same base URL resolution) rather than a second hand-rolled fetch —
 * `packages/shared/src/trigger-task.ts` already builds and tests this exact
 * request. `runId` is the run's `friendlyId` (`run_...`), not its internal
 * `id` — that's the format `buildRunStatusRequest`'s own test table uses and
 * the format every issue body's `runLink` already displays.
 */
export async function fetchRunDetailForProject(projectKey: string, runId: string): Promise<{ error?: unknown }> {
  const detail = await getTriggerRun(projectKey, runId);
  return { error: detail.error };
}
