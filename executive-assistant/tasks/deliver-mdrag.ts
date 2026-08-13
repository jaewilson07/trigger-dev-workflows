import { task, logger } from "@trigger.dev/sdk";
import { skipped, type BriefDeliveryBase, type DeliveryOutcome } from "../lib/brief-delivery.js";
import { resolveDatacrewToken } from "../lib/mdrag-seen-articles.js";

/**
 * mdrag delivery for the morning brief — archives the day's rendered
 * markdown into the wiki (`POST /ingest/text`), tagged with
 * `metadata.configuration` recording exactly which of today's Tracked-Topics
 * articles it drew from (jaewilson07/mdrag#1034). Mirrors `tasks/report-mdrag.ts`
 * (STORM's closest precedent for "post a rendered document to mdrag") in
 * shape: same auth env var this workflow already requires
 * (`DATACREW_API_TOKEN` — matches `lib/mdrag-seen-articles.ts`'s dedup calls,
 * not `report-mdrag.ts`'s `MDRAG_TOKEN`, since this task lives in the same
 * morning-brief pipeline that already mandates that token for Part A's
 * dedup/blurb mechanism, so requiring a second credential would be a second
 * thing to provision for no benefit), and the "unconfigured is `skipped`,
 * a genuine ingest failure throws" convention every destination here shares.
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
 */
export type DeliverMdragPayload = BriefDeliveryBase & {
  /** Defaults to MORNING_BRIEF_MDRAG_COLLECTION_ID, then mdrag's own personal-collection resolution. */
  collectionId?: string;
};

type IngestTextResponse = { document_uid?: string; id?: string; url?: string };

const MDRAG_INGEST_TEXT_URL = "https://wiki.datacrew.space/api/v1/ingest/text";

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
      }),
      // Matches output-mdrag-ingest.ts's /ingest/text budget: this endpoint
      // runs a synchronous save-time summary annotation (ADR-0017) before
      // responding, live-verified to take up to ~60-70s on a cold model.
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new Error(`mdrag ingest failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json().catch(() => ({}))) as IngestTextResponse;
    const documentUid = data.document_uid ?? data.id ?? null;

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
      url: data.url ?? null,
      documentUid,
      collectionId: collectionId || null,
    };
  },
});
