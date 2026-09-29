import { buildRunStatusRequest, getTriggerSecretKey } from "@datacrew/trigger-shared";
import { selectPreviousRunId } from "../../lib/previousRunSelect.js";

/**
 * Output of a task's most recent COMPLETED run in the watchdog project, or null
 * when it has never completed. The site monitors keep their debounce/dedupe
 * state in their own run outputs: a Trigger.dev container has no durable disk,
 * and a write to the secret store every few minutes would abuse it.
 *
 * AUTH. `domoDocsReport.ts` rejected `runs.list` from the SDK because it needs
 * its own credentials story. This follows the pattern `failureAlertFetch.ts`
 * already runs in production instead: the project's OWN secret key from
 * Infisical (fetched once per call) against the management REST API on the
 * self-hosted instance.
 *
 * RISK. The `filter[...]` list params are the documented v1 shape but are not
 * yet exercised live in this repo. A non-2xx throws, but an API that ignores an
 * unknown filter answers 200 with an unrelated run, so the first row is checked
 * by `selectPreviousRunId` (task id and COMPLETED status) and a mismatch throws
 * `PreviousRunMismatchError` instead of being trusted.
 */
const PROJECT_KEY = "watchdog";
const API_BASE = (process.env.TRIGGER_API_URL ?? "https://triggers.datacrew.space").replace(/\/+$/, "");

export async function previousRunOutput<T>(taskIdentifier: string): Promise<T | null> {
  const secretKey = await getTriggerSecretKey(PROJECT_KEY);
  const headers = { Authorization: `Bearer ${secretKey}` };
  const url = new URL(`${API_BASE}/api/v1/runs`);
  url.searchParams.set("filter[taskIdentifier]", taskIdentifier);
  url.searchParams.set("filter[status]", "COMPLETED");
  url.searchParams.set("page[size]", "1");
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`previousRunOutput(${taskIdentifier}): GET /api/v1/runs failed with ${res.status}: ${await res.text()}`);
  }
  const runId = selectPreviousRunId((await res.json()) as Parameters<typeof selectPreviousRunId>[0], taskIdentifier);
  if (!runId) return null;
  const req = buildRunStatusRequest(secretKey, runId);
  const detailRes = await fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(30_000) });
  if (!detailRes.ok) {
    throw new Error(`previousRunOutput(${taskIdentifier}): GET run ${runId} failed with ${detailRes.status}: ${await detailRes.text()}`);
  }
  const detail = (await detailRes.json()) as { output?: unknown };
  return (detail.output ?? null) as T | null;
}
