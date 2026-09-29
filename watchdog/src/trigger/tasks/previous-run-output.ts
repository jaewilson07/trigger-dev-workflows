import { getTriggerRun, getTriggerSecretKey } from "@datacrew/trigger-shared";

/**
 * Output of a task's most recent COMPLETED run in the watchdog project, or null
 * when it has never completed. The site monitors keep their debounce/dedupe
 * state in their own run outputs: a Trigger.dev container has no durable disk,
 * and a write to the secret store every few minutes would abuse it.
 *
 * AUTH. `domoDocsReport.ts` rejected `runs.list` from the SDK because it needs
 * its own credentials story. This follows the pattern `failureAlertFetch.ts`
 * already runs in production instead: the project's OWN secret key from
 * Infisical (`getTriggerSecretKey("watchdog")`) against the management REST API
 * on the self-hosted instance, and `getTriggerRun` for the run detail. Risk:
 * the `filter[...]` list params below are the documented v1 shape but are not
 * yet exercised live in this repo; a wrong shape throws (non-2xx), never
 * silently returns "no state".
 */
const PROJECT_KEY = "watchdog";
const API_BASE = (process.env.TRIGGER_API_URL ?? "https://triggers.datacrew.space").replace(/\/+$/, "");

export async function previousRunOutput<T>(taskIdentifier: string): Promise<T | null> {
  const secretKey = await getTriggerSecretKey(PROJECT_KEY);
  const url = new URL(`${API_BASE}/api/v1/runs`);
  url.searchParams.set("filter[taskIdentifier]", taskIdentifier);
  url.searchParams.set("filter[status]", "COMPLETED");
  url.searchParams.set("page[size]", "1");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`previousRunOutput(${taskIdentifier}): GET /api/v1/runs failed with ${res.status}`);
  }
  const list = (await res.json()) as { data?: Array<{ id?: string }> };
  const runId = list.data?.[0]?.id;
  if (!runId) return null;
  const detail = await getTriggerRun(PROJECT_KEY, runId);
  return (detail.output ?? null) as T | null;
}
