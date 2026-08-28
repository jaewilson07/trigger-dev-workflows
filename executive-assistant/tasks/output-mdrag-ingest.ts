import { task, logger } from "@trigger.dev/sdk";
import { dedupeSourceUrls, outputDelivered, outputFailed, outputSkipped } from "../lib/storm-types.js";
import type { Finding, StormBriefingWithMarkdown, OutputResult } from "../lib/storm-types.js";
import { pollMdragJob, type MdragJobEnqueueResponse } from "../lib/mdrag-job-poll.js";

export type OutputMdragIngestPayload = {
  briefing: StormBriefingWithMarkdown;
  topic: string;
  /**
   * Every finding gathered across the run, same array `output-mdrag-ingest-
   * sources` ingests — used ONLY to compute `metadata.configuration.source_urls`
   * below (jaewilson07/mdrag#1034), not to ingest anything itself. The report
   * document this task creates should record what fed it (its citations), so a
   * reader — or a future STORM run — can trace the report back to its sources
   * without a second lookup against `output-mdrag-ingest-sources`' own result.
   */
  findings: Finding[];
  /** `false` returns `skipped` — how `storm-deliver` says "not requested". */
  enabled?: boolean;
  /**
   * Explicit destination collection. Omitted by default: mdrag resolves the
   * ingest to the caller's own `personal:<email>` collection (auto-created
   * on first use), attributed from the identity already carried by the
   * `DATACREW_API_TOKEN` bearer token below — no collection_id/source_group
   * needed for that to work. Set this to route a run somewhere else (e.g. a
   * shared project collection) instead. See jaewilson07/mdrag#1017,
   * jaewilson07/trigger-dev-workflows#48.
   */
  mdragCollectionId?: string;
};

const MDRAG_ORIGIN = "https://wiki.datacrew.space";
const MDRAG_INGEST_URL = `${MDRAG_ORIGIN}/api/v1/ingest/text`;

/**
 * output-mdrag-ingest — pushes the Markdown report into the mdrag knowledge
 * base so future research (and the Slack bots) can retrieve it.
 *
 * Never throws: a failed ingest is reported as `success: false` so it can't
 * sink the other output destinations.
 *
 * MIGRATED TO async_mode 2026-08-13 (jaewilson07/mdrag#1043): see
 * `lib/mdrag-job-poll.ts`'s header for the full rationale — this used to POST
 * synchronously with a 120s timeout as a stopgap against mdrag's save-time
 * summary Annotation running long on a cold model; that stopgap could only
 * shrink Cloudflare's edge-timeout failure window, not close it. Now enqueues
 * and polls to a terminal state instead, still inside the same try/catch so a
 * job that never finishes (or fails) degrades to `outputFailed`, not a throw.
 */
export const outputMdragIngest = task({
  id: "output-mdrag-ingest",
  retry: { maxAttempts: 1 },
  run: async (payload: OutputMdragIngestPayload): Promise<OutputResult> => {
    logger.info("starting output-mdrag-ingest");
    if (payload.enabled === false) {
      return outputSkipped("mdrag", "not requested");
    }
    const { briefing, topic, findings, mdragCollectionId } = payload;
    const sourceUrls = dedupeSourceUrls(findings);

    const token = process.env.DATACREW_API_TOKEN ?? "";
    if (!token) {
      const error = "DATACREW_API_TOKEN not set";
      logger.warn("output-mdrag-ingest: skipping ingest", { error });
      return outputSkipped("mdrag", error);
    }

    try {
      // Enqueue-only (async_mode: true) — response comes back the moment the
      // job is queued, well under a second; pollMdragJob below waits for the
      // actual ingest + summary Annotation (jaewilson07/mdrag#1020, ADR-0017)
      // work.
      const res = await fetch(MDRAG_INGEST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: briefing.markdown,
          ...(mdragCollectionId ? { collection_id: mdragCollectionId } : {}),
          // mdrag#1034: records which cited source URLs (recreatable via
          // `output-mdrag-ingest-sources`' own ingest) fed this report — see
          // this task's `findings` doc comment.
          metadata: { configuration: { source_urls: sourceUrls } },
          async_mode: true,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        throw new Error(`mdrag ingest error: ${res.status} ${await res.text()}`);
      }

      const job = (await res.json()) as MdragJobEnqueueResponse;
      const jobResult = await pollMdragJob(MDRAG_ORIGIN, job.status_url, token);
      if (!jobResult.ok) {
        throw new Error(`mdrag ingest job failed: ${jobResult.error}`);
      }

      logger.info("output-mdrag-ingest: ingested report", {
        topic,
        markdownChars: briefing.markdown.length,
        documentUid: jobResult.documentUid,
      });

      return outputDelivered("mdrag");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn("output-mdrag-ingest: ingest failed", { error, topic });
      return outputFailed("mdrag", error);
    }
  },
});
