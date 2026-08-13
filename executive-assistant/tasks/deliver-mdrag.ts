import { task, logger } from "@trigger.dev/sdk";
import { skipped, type BriefDeliveryBase, type DeliveryOutcome } from "../lib/brief-delivery.js";
import { resolveDatacrewToken } from "../lib/mdrag-seen-articles.js";
import { pollMdragJob, type MdragJobEnqueueResponse } from "../lib/mdrag-job-poll.js";

/**
 * mdrag delivery for the morning brief — archives the day's rendered
 * markdown into the wiki (`POST /ingest/text`), tagged with
 * `metadata.configuration` recording exactly which of today's Tracked-Topics
 * articles it drew from (jaewilson07/mdrag#1034). Mirrors `tasks/report-mdrag.ts`
 * (STORM's closest precedent for "post a rendered document to mdrag") in
 * shape: same auth env var every mdrag-ingesting task in this project uses —
 * `DATACREW_API_TOKEN` via `resolveDatacrewToken()` — matching
 * `lib/mdrag-seen-articles.ts`'s dedup calls, `output-mdrag-ingest.ts`,
 * `output-mdrag-ingest-sources.ts`, and (as of the auth fix below)
 * `report-mdrag.ts` too. This task lives in the same morning-brief pipeline
 * that already mandates that token for Part A's dedup/blurb mechanism, so
 * reusing it means no second credential to provision, and the "unconfigured
 * is `skipped`, a genuine ingest failure throws" convention every destination
 * here shares.
 *
 * COLLECTION ID IS OPTIONAL, not required. Unlike `report-mdrag.ts`
 * (`REPORT_MDRAG_COLLECTION_ID` required, `skipped` without it),
 * this follows the newer convention `output-mdrag-ingest.ts` /
 * `output-mdrag-ingest-sources.ts` established (mdrag#1017,
 * trigger-dev-workflows#48): omitted, mdrag resolves the ingest to the
 * caller's own `personal:<email>` collection from the bearer token's
 * identity, auto-created on first use. Set `MORNING_BRIEF_MDRAG_COLLECTION_ID`
 * (or the payload override) to route somewhere else instead.
 *
 * `input_document_uids`/`input_urls` come from `payload.research.topicResults`
 * — every `TopicSearchResultItem` actually selected for today's brief carries
 * its `documentUid`/`blurb` once Part A (`lib/mdrag-topic-search.ts`) selects
 * it, so this task only flattens what's already there; it does no additional
 * mdrag I/O of its own to compute them.
 *
 * MIGRATED TO async_mode 2026-08-13 (jaewilson07/mdrag#1043): see
 * `lib/mdrag-job-poll.ts`'s header for the full rationale — this used to POST
 * synchronously with a 120s timeout as a stopgap against mdrag's save-time
 * summary Annotation running long on a cold model; that stopgap could only
 * shrink Cloudflare's edge-timeout failure window, not close it. Now enqueues
 * and polls to a terminal state instead.
 */
export type DeliverMdragPayload = BriefDeliveryBase & {
  /** Defaults to MORNING_BRIEF_MDRAG_COLLECTION_ID, then mdrag's own personal-collection resolution. */
  collectionId?: string;
};

const MDRAG_ORIGIN = "https://wiki.datacrew.space";
const MDRAG_INGEST_TEXT_URL = `${MDRAG_ORIGIN}/api/v1/ingest/text`;

/**
 * Flattens every article actually selected for today's brief (Part A already
 * gated this — only items with a `documentUid` were shown) into the two
 * parallel arrays mdrag#1034's `configuration` convention wants.
 */
function shownArticles(research: BriefDeliveryBase["research"]): { documentUids: string[]; urls: string[] } {
  const documentUids: string[] = [];
  const urls: string[] = [];
  for (const topicResult of research.topicResults) {
    for (const item of topicResult.results) {
      if (!item.documentUid) continue; // never selected for display — Part A only sets this on shown items
      documentUids.push(item.documentUid);
      urls.push(item.url);
    }
  }
  return { documentUids, urls };
}

export const deliverMdrag = task({
  id: "deliver-mdrag",
  // One retry: ingest is not idempotent by default (no explicit source_url
  // here, so a retry that lands after a partial success creates a second
  // wiki document for the same day) — same trade-off `report-mdrag.ts`
  // documents, and the same conclusion: a duplicate archived brief is
  // cheaper than a silently missing one.
  retry: { maxAttempts: 2 },
  run: async (payload: DeliverMdragPayload): Promise<DeliveryOutcome> => {
    logger.info("starting deliver-mdrag");
    if (payload.enabled === false) {
      return skipped("mdrag", "disabled by caller");
    }

    const token = resolveDatacrewToken();
    if (!token) {
      return skipped("mdrag", "DATACREW_API_TOKEN not set");
    }

    const collectionId = payload.collectionId ?? process.env.MORNING_BRIEF_MDRAG_COLLECTION_ID ?? "";
    const { documentUids, urls } = shownArticles(payload.research);

    // Enqueue-only (async_mode: true) — response comes back the moment the
    // job is queued, well under a second; pollMdragJob below waits for the
    // actual ingest + summary Annotation work.
    const res = await fetch(MDRAG_INGEST_TEXT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: payload.briefMarkdown,
        source_title: `Morning Brief — ${payload.research.date}`,
        ...(collectionId ? { collection_id: collectionId } : {}),
        metadata: {
          configuration: {
            input_document_uids: documentUids,
            input_urls: urls,
          },
        },
        async_mode: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`mdrag ingest failed: ${res.status} ${await res.text()}`);
    }

    const job = (await res.json()) as MdragJobEnqueueResponse;
    const jobResult = await pollMdragJob(MDRAG_ORIGIN, job.status_url, token);
    if (!jobResult.ok) {
      throw new Error(`mdrag ingest job failed: ${jobResult.error}`);
    }
    const documentUid = jobResult.documentUid;

    logger.info("Archived morning brief into mdrag", {
      date: payload.research.date,
      collectionId: collectionId || "(personal, resolved by mdrag)",
      documentUid,
      shownArticleCount: documentUids.length,
    });
    logger.info("completed deliver-mdrag", { documentUid, shownArticleCount: documentUids.length });

    return {
      destination: "mdrag",
      status: "delivered",
      // mdrag never returns a document URL from this endpoint — always null.
      url: null,
      documentUid,
      collectionId: collectionId || null,
    };
  },
});
