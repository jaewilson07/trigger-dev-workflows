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
};

type IngestResponse = { id?: string; url?: string; document_id?: string };

export const reportMdrag = task({
  id: "report-mdrag",
  // One retry: ingest is not idempotent (a second call creates a second wiki
  // document), so a retry trades a possible duplicate for a possible loss.
  // Duplicates in a searchable wiki are the cheaper failure.
  retry: { maxAttempts: 2 },
  run: async (payload: ReportMdragPayload): Promise<ReportOutcome> => {
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
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      throw new Error(`mdrag ingest failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json().catch(() => ({}))) as IngestResponse;
    const documentId = data.document_id ?? data.id ?? null;

    logger.info("Ingested research report into mdrag", {
      workflow: payload.report.workflow,
      collectionId,
      documentId,
      markdownChars: payload.markdown.length,
    });

    return {
      destination: "mdrag",
      status: "delivered",
      url: data.url ?? null,
      documentId,
      collectionId,
    };
  },
});
