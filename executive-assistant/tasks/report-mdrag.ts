import { task, logger } from "@trigger.dev/sdk";
import { reportSkipped, type ReportDeliveryBase, type ReportOutcome } from "../lib/report-delivery.js";

/**
 * mdrag delivery for a research report — pushes the markdown into the wiki so
 * future research (and the Slack bots) can retrieve it.
 *
 * COLLECTION ID COMES FROM ENV, not a constant. storm-research's own
 * `output-mdrag-ingest.ts` hardcodes `MDRAG_COLLECTION_ID`, which the
 * composition audit flagged (R2d): every other destination in this project
 * reads its own config, and a hardcoded collection means a second environment
 * silently writes into the first one's wiki. Unset is `skipped`, not a guess.
 *
 * `MDRAG_TOKEN` is the same credential `lib/mdrag-topic-search.ts` and
 * `lib/mdrag-primitives.ts` already use, so nothing new needs provisioning.
 */
export type ReportMdragPayload = ReportDeliveryBase & {
  /** Defaults to REPORT_MDRAG_COLLECTION_ID. */
  collectionId?: string;
  /** Defaults to REPORT_MDRAG_SOURCE_GROUP, then "datacrew". */
  sourceGroup?: string;
  /**
   * mdrag#1034: recorded on the ingested document as `metadata.configuration`
   * — what this report was produced FROM (e.g. email-digest-deliver's input
   * email count/subjects). Producer-defined shape, omitted entirely (no
   * `metadata` key sent) when the caller has none, so Pattern Hunter/Deep
   * Researcher's existing calls — which don't pass this — are unaffected.
   */
  configuration?: Record<string, unknown>;
};

// mdrag#1037: POST /ingest/text returns `document_uid` (previously it
// returned none of `id`/`url`/`document_id` — `documentId` below was always
// null, live-verified 2026-08-13). It never returns a `url`.
type IngestResponse = { document_uid?: string };

export const reportMdrag = task({
  id: "report-mdrag",
  // One retry: ingest is not idempotent (a second call creates a second wiki
  // document), so a retry trades a possible duplicate for a possible loss.
  // Duplicates in a searchable wiki are the cheaper failure.
  retry: { maxAttempts: 2 },
  run: async (payload: ReportMdragPayload): Promise<ReportOutcome> => {
    logger.info("starting report-mdrag");
    if (payload.enabled === false) {
      return reportSkipped("mdrag", "disabled by caller");
    }

    const collectionId = payload.collectionId ?? process.env.REPORT_MDRAG_COLLECTION_ID ?? "";
    if (!collectionId) {
      return reportSkipped("mdrag", "REPORT_MDRAG_COLLECTION_ID not set and no collectionId in payload");
    }

    const token = process.env.MDRAG_TOKEN ?? "";
    if (!token) {
      return reportSkipped("mdrag", "MDRAG_TOKEN not set");
    }

    const baseUrl = (process.env.MDRAG_URL ?? "https://wiki.datacrew.space").replace(/\/$/, "");
    const sourceGroup = payload.sourceGroup ?? process.env.REPORT_MDRAG_SOURCE_GROUP ?? "datacrew";

    // Unlike the two constants above, a genuine ingest failure THROWS rather
    // than returning `skipped` — "the wiki rejected this" is not a well-formed
    // refusal. Trigger.dev's retry applies, and `report-deliver` records the
    // final failure as one `failed` destination without touching its siblings.
    const res = await fetch(`${baseUrl}/api/v1/ingest/text`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: payload.markdown,
        collection_id: collectionId,
        source_group: sourceGroup,
        title: payload.report.title,
        ...(payload.configuration ? { metadata: { configuration: payload.configuration } } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      throw new Error(`mdrag ingest failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json().catch(() => ({}))) as IngestResponse;
    const documentId = data.document_uid ?? null;

    logger.info("Ingested research report into mdrag", {
      workflow: payload.report.workflow,
      collectionId,
      documentId,
      markdownChars: payload.markdown.length,
    });
    logger.info("completed report-mdrag", { documentId, collectionId });

    return {
      destination: "mdrag",
      status: "delivered",
      // mdrag never returns a document URL from this endpoint (see the
      // IngestResponse comment above) — always null, not a bug.
      url: null,
      documentId,
      collectionId,
    };
  },
});
