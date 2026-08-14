import { pollMdragJob, type MdragJobEnqueueResponse, type MdragJobPollResult } from "./mdrag-job-poll.js";

/**
 * Shared `POST /api/v1/ingest/text` enqueue-then-poll sequence
 * (jaewilson07/trigger-dev-workflows#74) — the request-building/enqueue half
 * of the mechanics every mdrag-ingesting task in this project duplicated
 * (`tasks/report-mdrag.ts`, `tasks/deliver-mdrag.ts`,
 * `tasks/output-mdrag-ingest.ts`, `lib/mdrag-seen-articles.ts`'s
 * `recordShownArticleDocumentUids`), paired with the already-shared
 * `pollMdragJob` (see `lib/mdrag-job-poll.ts`'s header for why the poll half
 * exists at all — `async_mode: true` is mandatory here for the same reason).
 *
 * MECHANICS ONLY. This module does not decide skip-vs-required for any
 * field, does not decide throw-vs-catch for a caller's own outcome
 * vocabulary, and does not pick an outcome shape beyond mirroring
 * `pollMdragJob`'s own discriminated result — those are each caller's
 * policy, not this module's. It never throws itself: a network failure on
 * the enqueue request is caught and returned as `{ ok: false, error }`, same
 * as every other failure path here.
 *
 * FIELD NAMES MATCH THE FIRST CALLER (`report-mdrag.ts`), NOT EVERY CALLER
 * YET. `deliver-mdrag.ts` and `lib/mdrag-seen-articles.ts` currently send
 * `source_title` instead of `title` — an existing inconsistency between
 * callers, not something this module resolves. Only `report-mdrag.ts`
 * migrates in #74; the other three (source_title vs title, source_url, and
 * whether metadata is always-present vs optional) are follow-up issues #81
 * and #82.
 */
export type MdragTextIngestInput = {
  /** Origin, e.g. "https://wiki.datacrew.space" — no trailing slash required. */
  baseUrl: string;
  /** Already-resolved bearer token (e.g. from `resolveDatacrewToken()`). */
  token: string;
  /** The document body to ingest. */
  content: string;
  /** Sent as `collection_id` when supplied. Omitted entirely otherwise. */
  collectionId?: string;
  /** Sent as `source_group` when supplied. Omitted entirely otherwise. */
  sourceGroup?: string;
  /** Sent as `title` when supplied. Omitted entirely otherwise. */
  title?: string;
  /** Sent as `metadata` when supplied. Omitted entirely otherwise. */
  metadata?: Record<string, unknown>;
};

/** Mirrors `pollMdragJob`'s own discriminated result verbatim. */
export type MdragTextIngestResult = MdragJobPollResult;

/**
 * POSTs `{baseUrl}/api/v1/ingest/text` with `async_mode: true` always set
 * (30s request timeout — generous headroom for the enqueue round-trip
 * itself, not a completion budget: mdrag returns 202 the instant the job is
 * queued), then hands the enqueue response's `status_url` off to
 * `pollMdragJob` for the actual ingest + summary Annotation work. Never
 * throws — every failure path (enqueue network error, enqueue non-2xx, job
 * failure, poll timeout) returns `{ ok: false, error }` instead.
 */
export async function ingestMdragText(input: MdragTextIngestInput): Promise<MdragTextIngestResult> {
  const baseUrl = input.baseUrl.replace(/\/$/, "");

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/ingest/text`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: input.content,
        ...(input.collectionId ? { collection_id: input.collectionId } : {}),
        ...(input.sourceGroup ? { source_group: input.sourceGroup } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        async_mode: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `mdrag ingest request failed: ${error}` };
  }

  if (!res.ok) {
    return { ok: false, error: `mdrag ingest failed: ${res.status} ${await res.text()}` };
  }

  const job = (await res.json()) as MdragJobEnqueueResponse;
  return pollMdragJob(baseUrl, job.status_url, input.token);
}
