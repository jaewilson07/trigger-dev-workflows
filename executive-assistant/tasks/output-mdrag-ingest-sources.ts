import { task, logger } from "@trigger.dev/sdk";
import { sourceIngestCompleted, sourceIngestSkipped } from "../lib/storm-types.js";
import type { Finding, SourceIngestResult } from "../lib/storm-types.js";

export type OutputMdragIngestSourcesPayload = {
  /**
   * Every finding gathered across every perspective's interview for this
   * run — see `StormResearch.findings`. This task owns de-dup/filtering so
   * callers never have to: empty `source` values are dropped, and a URL
   * cited by more than one finding is only ingested once.
   */
  findings: Finding[];
  topic: string;
  /** `false` returns `skipped` — how `storm-deliver` says "not requested". */
  enabled?: boolean;
  /**
   * Explicit destination collection. Omitted by default: mdrag resolves the
   * ingest to the caller's own `personal:<email>` collection, same as
   * `output-mdrag-ingest`'s `mdragCollectionId` — see that task's doc
   * comment for the full rationale. Sources always land in the same
   * collection as the run's final report, so callers should pass the same
   * value here as they do to `output-mdrag-ingest`.
   */
  mdragCollectionId?: string;
};

const MDRAG_INGEST_WEB_URL = "https://wiki.datacrew.space/api/v1/ingest/web";

/**
 * output-mdrag-ingest-sources — sibling to `output-mdrag-ingest`. That task
 * pushes the *final composed report*; this one pushes every unique source
 * URL the research actually cited, so the raw material behind the report is
 * still findable in mdrag after the run finishes. See
 * jaewilson07/trigger-dev-workflows#50, jaewilson07/mdrag#1026.
 *
 * Unlike `output-mdrag-ingest` (which POSTs pre-composed markdown to
 * `/api/v1/ingest/text`), this hits `/api/v1/ingest/web` — mdrag crawls the
 * URL server-side, so STORM never needs to have already fetched the page
 * content itself; it only ever has citation URLs.
 *
 * Never throws: a failed individual URL enqueue is recorded and the rest
 * still proceed. The aggregate outcome is `SourceIngestResult` rather than
 * `OutputResult` — one call covers N URLs, so a single success/url pair
 * can't represent "12 of 14 queued" the way it does for a single-document
 * destination. See `lib/storm-types.ts` for why this is `queued`, not
 * `delivered` — mdrag's `/api/v1/ingest/web` is async, so this task never
 * confirms a source actually finished ingesting.
 */
export const outputMdragIngestSources = task({
  id: "output-mdrag-ingest-sources",
  retry: { maxAttempts: 1 },
  run: async (payload: OutputMdragIngestSourcesPayload): Promise<SourceIngestResult> => {
    logger.info("starting output-mdrag-ingest-sources", {
      topic: payload.topic,
      findingCount: payload.findings.length,
    });

    if (payload.enabled === false) {
      return sourceIngestSkipped("not requested");
    }

    const { findings, topic, mdragCollectionId } = payload;

    const token = process.env.DATACREW_API_TOKEN ?? "";
    if (!token) {
      const error = "DATACREW_API_TOKEN not set";
      logger.warn("output-mdrag-ingest-sources: skipping ingest", { error });
      return sourceIngestSkipped(error);
    }

    const urls = dedupeSourceUrls(findings);

    if (urls.length === 0) {
      logger.info("output-mdrag-ingest-sources: no non-empty source URLs to ingest", { topic });
      return sourceIngestSkipped("no non-empty source URLs found in findings");
    }

    logger.info("output-mdrag-ingest-sources: ingesting sources", {
      topic,
      findingCount: findings.length,
      uniqueSourceCount: urls.length,
    });

    let queued = 0;
    let queueFailed = 0;

    for (const url of urls) {
      try {
        const res = await fetch(MDRAG_INGEST_WEB_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url,
            ...(mdragCollectionId ? { collection_id: mdragCollectionId } : {}),
          }),
          // Unlike output-mdrag-ingest.ts's /api/v1/ingest/text (synchronous),
          // /api/v1/ingest/web is ASYNC — it returns 202 the moment the crawl
          // job is queued, well before the actual crawl/embed/annotate work
          // runs in mdrag's background worker (live-verified 2026-08-12: the
          // enqueue call itself returns in well under a second, while the
          // real ingest can take minutes — a cold-loaded summarizer alone can
          // push it to ~60-70s, per output-mdrag-ingest.ts's own note). So
          // `queued`/`queueFailed` below reflect whether the job was
          // successfully QUEUED, not whether it finished processing — this
          // task never polls a source's ingest to completion. 120s is
          // generous headroom for the enqueue request itself (network/auth),
          // not a completion budget.
          signal: AbortSignal.timeout(120_000),
        });

        if (!res.ok) {
          throw new Error(`mdrag ingest/web error: ${res.status} ${await res.text()}`);
        }

        queued += 1;
      } catch (err) {
        queueFailed += 1;
        const error = err instanceof Error ? err.message : String(err);
        logger.warn("output-mdrag-ingest-sources: source ingest job failed to queue", { url, error });
      }
    }

    const result = sourceIngestCompleted({ total: urls.length, queued, queue_failed: queueFailed });
    logger.info("completed output-mdrag-ingest-sources", {
      topic,
      total: urls.length,
      queued,
      queueFailed,
      status: result.status,
    });

    return result;
  },
});

/**
 * Filters out empty/falsy `source` values and de-dupes by exact URL,
 * preserving first-seen order — a source cited by multiple findings across
 * perspectives is only ingested once.
 */
function dedupeSourceUrls(findings: Finding[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const f of findings) {
    const url = f.source?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}
