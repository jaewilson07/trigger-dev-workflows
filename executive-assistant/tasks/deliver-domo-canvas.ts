import { task, logger } from "@trigger.dev/sdk";
import { domoAuthFromEnv, replaceDatasetRows } from "../lib/domo-dataset.js";
import { briefRows } from "../lib/brief-rows.js";
import { skipped, type BriefDeliveryBase, type DeliveryOutcome } from "../lib/brief-delivery.js";

/**
 * Domo delivery: replaces the dataset the brief's card/dashboard reads.
 *
 * WHAT "DOMO CANVAS" MEANS HERE. Domo exposes no API for writing prose onto a
 * dashboard -- there is no canvas primitive to POST to, the way Slack has one.
 * A Domo card is bound to a DATASET and re-renders when that dataset changes,
 * so updating the dashboard means replacing rows. The card itself is built once
 * by hand in Domo against the schema in `lib/brief-rows.ts`; this task only
 * ever feeds it. See `docs/morning-brief-rework.md` for that one-time setup.
 *
 * `briefMarkdown` is intentionally unused: the markdown render is for Slack and
 * Drive. Domo gets the structured rows, which is what a card can actually
 * filter and sort.
 */
export type DeliverDomoCanvasPayload = BriefDeliveryBase & {
  /** Defaults to MORNING_BRIEF_DOMO_DATASET_ID. */
  datasetId?: string;
  /** Optional dashboard link, echoed back so a caller can surface it. */
  cardUrl?: string;
};

export const deliverDomoCanvas = task({
  id: "deliver-domo-canvas",
  // 2 attempts, matching the other outbound-HTTP tasks in this project. Safe to
  // repeat: the upload is a REPLACE, so a retry after a partial failure
  // overwrites rather than duplicating.
  retry: { maxAttempts: 2 },
  run: async (payload: DeliverDomoCanvasPayload): Promise<DeliveryOutcome> => {
    if (payload.enabled === false) {
      return skipped("domo", "disabled by caller");
    }

    const datasetId = payload.datasetId ?? process.env.MORNING_BRIEF_DOMO_DATASET_ID ?? "";
    if (!datasetId) {
      return skipped("domo", "MORNING_BRIEF_DOMO_DATASET_ID not set and no datasetId in payload");
    }

    const auth = domoAuthFromEnv();
    if (!auth) {
      return skipped("domo", "DOMO_INSTANCE and DOMO_ACCESS_TOKEN are not both set");
    }

    const rows = briefRows(payload.research);
    const result = await replaceDatasetRows(auth, datasetId, rows);

    logger.info("Replaced Domo brief dataset", {
      datasetId,
      instance: auth.instance,
      rowCount: result.rowCount,
    });

    return {
      destination: "domo",
      status: "delivered",
      url: payload.cardUrl ?? process.env.MORNING_BRIEF_DOMO_CARD_URL ?? null,
      datasetId,
      uploadId: result.uploadId,
      rowCount: result.rowCount,
    };
  },
});
