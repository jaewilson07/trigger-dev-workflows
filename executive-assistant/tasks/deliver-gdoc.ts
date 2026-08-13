import { task, logger } from "@trigger.dev/sdk";
import { upsertMarkdownDoc } from "../lib/google-docs.js";
import { skipped, type BriefDeliveryBase, type DeliveryOutcome } from "../lib/brief-delivery.js";

/**
 * Google Doc delivery: writes the rendered brief into Drive.
 *
 * TWO MODES, chosen by whether a document id is supplied:
 *   - `documentId` set  -> that doc is overwritten in place. One stable URL to
 *                          bookmark, always showing today's brief.
 *   - no `documentId`   -> a new dated doc per run, optionally in `folderId`.
 *                          An archive, at the cost of a new URL each morning.
 * Rolling is the default posture for a daily cron (set
 * MORNING_BRIEF_GDOC_DOCUMENT_ID); the archive mode is what you get if you only
 * set a folder.
 *
 * See `lib/google-docs.ts` for why this goes direct through `google-auth.ts`
 * rather than reusing `pattern-hunter-publish-gdoc.ts`, and for the Drive
 * scope this needs on the stored token.
 */
export type DeliverGDocPayload = BriefDeliveryBase & {
  /** Defaults to the research's own ownerEmail — the Google identity, not Slack/Letta. */
  ownerEmail?: string;
  /** Defaults to MORNING_BRIEF_GDOC_DOCUMENT_ID. Set -> overwrite in place. */
  documentId?: string;
  /** Defaults to MORNING_BRIEF_GDOC_FOLDER_ID. Only used when creating. */
  folderId?: string;
  /** Defaults to `Morning Brief — <research date>`. */
  title?: string;
};

export const deliverGDoc = task({
  id: "deliver-gdoc",
  // Same reason as `fetch-emails`: importing `googleapis` pulls in the whole
  // discovery surface and SIGKILLs on the 0.5 GB default before any user code
  // runs, which reads as an unexplained crash rather than an OOM.
  machine: "small-2x",
  // Covers a transient auth-service or Drive 5xx. Re-running is safe in both
  // modes: overwrite is idempotent, and a duplicate dated doc is recoverable
  // in a way a missing brief is not.
  retry: { maxAttempts: 2 },
  run: async (payload: DeliverGDocPayload): Promise<DeliveryOutcome> => {
    logger.info("starting deliver-gdoc");
    if (payload.enabled === false) {
      return skipped("gdoc", "disabled by caller");
    }

    const ownerEmail = payload.ownerEmail ?? payload.research.ownerEmail;
    if (!ownerEmail) {
      return skipped("gdoc", "no ownerEmail on the payload or the research");
    }

    const documentId = payload.documentId ?? process.env.MORNING_BRIEF_GDOC_DOCUMENT_ID ?? "";
    const folderId = payload.folderId ?? process.env.MORNING_BRIEF_GDOC_FOLDER_ID ?? "";

    const result = await upsertMarkdownDoc({
      ownerEmail,
      title: payload.title ?? `Morning Brief — ${payload.research.date}`,
      markdown: payload.briefMarkdown,
      ...(documentId ? { documentId } : {}),
      ...(folderId ? { folderId } : {}),
    });

    logger.info("Published morning brief to Google Docs", {
      ownerEmail,
      documentId: result.documentId,
      created: result.created,
    });
    logger.info("completed deliver-gdoc", { documentId: result.documentId, created: result.created });

    return {
      destination: "gdoc",
      status: "delivered",
      url: result.documentUrl,
      documentId: result.documentId,
      created: result.created,
    };
  },
});
