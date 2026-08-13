/**
 * Shared poll loop for mdrag's job-queue `async_mode` opt-in (jaewilson07/mdrag#1043,
 * ADR-0017 addendum) — the fix for a real, live-verified failure mode: every
 * `POST /api/v1/ingest/text` call in this project used to block on mdrag's
 * synchronous save-time summary Annotation, which calls an LLM with no timeout
 * of its own and has been observed to take 60-70s on a cold model swap — long
 * enough to run past Cloudflare's ~100s edge timeout in front of wiki.datacrew.space.
 * The stopgap (bump the client's own `AbortSignal.timeout` to 120s — see the
 * git history of `tasks/report-mdrag.ts`/`tasks/deliver-mdrag.ts`/
 * `tasks/output-mdrag-ingest.ts`) only shrank the failure window; it couldn't
 * close it, because Cloudflare's edge timeout isn't a client-side knob. The
 * actual fix is `async_mode: true`: mdrag returns 202 the instant the job is
 * queued (well under a second), and the ingest + annotation work happens off
 * the request entirely — this module is what turns that job_id into a
 * finished-or-failed result for a caller that still wants to know the outcome
 * before its own task completes.
 *
 * Every caller in this project follows the same shape: POST with
 * `async_mode: true` → 202 `{job_id, status, status_url}` → `pollMdragJob`
 * until `status` is `"finished"` or `"failed"` (mdrag's own terminal-state
 * vocabulary — see `interfaces/api/services/ingest.py::normalize_job_status`
 * on the mdrag side; this module never sees the raw backend `JobStatus` enum).
 */

export type MdragJobEnqueueResponse = {
  job_id: string;
  status: string;
  status_url: string;
};

export type MdragJobPollResult =
  | { ok: true; documentUid: string | null; result: Record<string, unknown> }
  | { ok: false; error: string };

export type MdragJobPollOptions = {
  /** Delay between status checks. Default 5s. */
  intervalMs?: number;
  /**
   * Total time budget for the poll loop. Default 10 minutes — generous
   * headroom over the ~2m37s worst case live-verified against production
   * (mdrag#1043's live test: RQ worker cold-boot + a cold-loaded summarizer
   * model), well inside this project's own 3600s task `maxDuration`
   * (`trigger.config.ts`) and mdrag's matching 3600s RQ `job_timeout`.
   */
  timeoutMs?: number;
  /** Per-request timeout for each individual status check. Default 30s. */
  requestTimeoutMs?: number;
};

/**
 * Polls `GET {originUrl}{statusUrl}` (mdrag's `JobStatusResponse`) until the
 * job reaches a terminal state, or the poll budget runs out.
 *
 * `documentUid` is read from `result.documents[0].document_uid` — the same
 * path every `"text"`-kind async job populates (see mdrag's
 * `IngestJobService.queue_text` docstring: "the completed job's
 * `result.documents[0].document_uid` is the same value the sync path returns
 * as `TextIngestResponse.document_uid`"). `null` for job kinds/results that
 * don't carry a single document (not currently exercised by this project's
 * callers, all of which are single-document `text` ingests).
 */
export async function pollMdragJob(
  originUrl: string,
  statusUrl: string,
  token: string,
  opts: MdragJobPollOptions = {}
): Promise<MdragJobPollResult> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  // new URL(relative, base) handles an absolute statusUrl (base ignored), a
  // leading-slash path, and a path missing its leading slash all correctly —
  // a plain string-concat join would silently produce an invalid URL for the
  // last case (e.g. "https://wiki.datacrew.spaceapi/v1/jobs/...").
  const url = new URL(statusUrl, originUrl).toString();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    if (!res.ok) {
      return { ok: false, error: `job status check failed: ${res.status} ${await res.text()}` };
    }

    const data = (await res.json()) as {
      status: string;
      error?: string | null;
      result?: Record<string, unknown> | null;
    };

    if (data.status === "finished") {
      const documents = (data.result?.["documents"] as Array<{ document_uid?: string }> | undefined) ?? [];
      const documentUid = documents[0]?.document_uid ?? null;
      return { ok: true, documentUid, result: data.result ?? {} };
    }

    if (data.status === "failed") {
      return { ok: false, error: data.error ?? "mdrag job failed with no error message" };
    }

    if (Date.now() + intervalMs > deadline) {
      return { ok: false, error: `mdrag job did not reach a terminal state within ${timeoutMs}ms (last status: ${data.status})` };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
