import { task, logger } from "@trigger.dev/sdk";
import { upsertMarkdownDoc } from "../lib/google-docs.js";
import { reportSkipped, type ReportDeliveryBase, type ReportOutcome } from "../lib/report-delivery.js";

/**
 * Google Doc delivery for a research report — Pattern Hunter, Deep Researcher,
 * or anything else that can produce a `ResearchReport`.
 *
 * WHY THIS EXISTS ALONGSIDE `deliver-gdoc.ts`. They share the one Drive
 * implementation (`lib/google-docs.ts`) and differ only in what they are typed
 * to and how they default: `deliver-gdoc` takes a `BriefResearch` and defaults
 * to MORNING_BRIEF_GDOC_DOCUMENT_ID — a single rolling doc a bookmark keeps
 * working against, which is right for a daily cron and wrong for research runs,
 * where each run is its own document and overwriting yesterday's would destroy
 * it. So the DEFAULT POSTURE IS INVERTED here: create a new dated doc unless a
 * `documentId` is explicitly supplied.
 *
 * WHY NOT `pattern-hunter-publish-gdoc.ts`. That task is Pattern Hunter's own
 * consent-dance endpoint, browser-triggered, and its `consent_required` result
 * is a legitimate answer for a human clicking a button and a silent stoppage
 * for a scheduled workflow — see `lib/google-docs.ts`'s own "WHY NOT" note,
 * which reaches the same conclusion for the brief. That task stays wired into
 * `pattern-hunter-deliver` as a SEPARATE, optional destination (it publishes to
 * the *end user's* Drive, this publishes to the workflow owner's), rather than
 * being replaced by this one.
 */
export type ReportGDocPayload = ReportDeliveryBase & {
  /** Defaults to the report's own ownerEmail, then MORNING_BRIEF_GOOGLE_OWNER_EMAIL. */
  ownerEmail?: string;
  /** Set to OVERWRITE a specific doc in place. Unset (the default) creates a new one. */
  documentId?: string;
  /** Defaults to REPORT_GDOC_FOLDER_ID. Only used when creating. */
  folderId?: string;
  /** Defaults to the report's own title. */
  title?: string;
};

export const reportGDoc = task({
  id: "report-gdoc",
  // Same reason as `deliver-gdoc`/`fetch-emails`: importing `googleapis` pulls
  // in the whole discovery surface and SIGKILLs on the 0.5 GB default before
  // any user code runs, which reads as an unexplained crash rather than an OOM.
  machine: "small-2x",
  // Covers a transient auth-service or Drive 5xx. A duplicate dated doc is
  // recoverable in a way a missing report is not.
  retry: { maxAttempts: 2 },
  run: async (payload: ReportGDocPayload): Promise<ReportOutcome> => {
    if (payload.enabled === false) {
      return reportSkipped("gdoc", "disabled by caller");
    }

    const ownerEmail =
      payload.ownerEmail ?? payload.report.ownerEmail ?? process.env.MORNING_BRIEF_GOOGLE_OWNER_EMAIL ?? "";
    if (!ownerEmail) {
      return reportSkipped(
        "gdoc",
        "no ownerEmail on the payload or report, and MORNING_BRIEF_GOOGLE_OWNER_EMAIL is not set"
      );
    }

    const documentId = payload.documentId ?? "";
    const folderId = payload.folderId ?? process.env.REPORT_GDOC_FOLDER_ID ?? "";

    const result = await upsertMarkdownDoc({
      ownerEmail,
      title: payload.title ?? payload.report.title,
      markdown: payload.markdown,
      ...(documentId ? { documentId } : {}),
      ...(folderId ? { folderId } : {}),
    });

    logger.info("Published research report to Google Docs", {
      workflow: payload.report.workflow,
      ownerEmail,
      documentId: result.documentId,
      created: result.created,
    });

    return {
      destination: "gdoc",
      status: "delivered",
      url: result.documentUrl,
      documentId: result.documentId,
      created: result.created,
    };
  },
});
