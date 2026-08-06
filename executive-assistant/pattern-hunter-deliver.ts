import { task, logger } from "@trigger.dev/sdk";
import { reportDeliver } from "./report-deliver.js";
import { patternHunterPublishGDoc } from "./tasks/pattern-hunter-publish-gdoc.js";
import { renderReportMarkdown } from "./lib/render-report.js";
import type { PatternHunterReport } from "./lib/pattern-hunter-types.js";
import type { ReportDeliveryResult, ResearchReport } from "./lib/report-delivery.js";

/**
 * The OUTPUT half of Pattern Hunter: turn a `PatternHunterReport` into the
 * project-wide `ResearchReport` seam and hand it to `report-deliver`.
 *
 * AN ADAPTER, NOT A SECOND FAN-OUT. The parallel `batch.triggerByTaskAndWait`
 * lives once, in `report-deliver.ts`; this file holds only what is genuinely
 * Pattern-Hunter-specific — the title, and the extra `publish/gdoc` destination
 * below. Deep Researcher has its own adapter for the same reason and they share
 * everything downstream of the seam.
 *
 * ## The orphan, folded in
 *
 * `pattern-hunter-publish-gdoc` was a correctly-shaped destination task
 * reachable only from the browser (`useRealtimeTaskTrigger` + a multi-use
 * token), chained from no orchestrator. It is now reachable BOTH ways —
 * wrapped, not replaced, because its contract was already destination-shaped
 * and the browser path is a real use case.
 *
 * It is NOT one of `report-deliver`'s three entries, and that is deliberate:
 * it publishes into the END USER's Drive via Pattern Hunter's own consent
 * dance, whereas `report-gdoc` publishes into the workflow owner's Drive with a
 * stored service token. Different Drive, different identity, different failure
 * mode — `consent_required` is a legitimate terminal answer here and a silent
 * stoppage for a scheduled job. Folding it into the same three-entry batch
 * would have forced one of those two behaviours onto the other.
 *
 * So it runs only when the caller supplies a `publishGDoc.user_id`, and its
 * `consent_required` result is reported as `skipped` with the consent URL in
 * the reason — a well-formed refusal, not a crash, the convention that task's
 * own docstring already established.
 */

export type PatternHunterDeliverPayload = {
  report: PatternHunterReport;
  /** `YYYY-MM-DD` the research is about. Defaults to the report's own generated_at date. */
  date?: string;
  /** Google identity to publish as. Defaults to MORNING_BRIEF_GOOGLE_OWNER_EMAIL at the destination. */
  ownerEmail?: string;
  slack?: { enabled?: boolean; channel?: string };
  gdoc?: { enabled?: boolean; ownerEmail?: string; documentId?: string; folderId?: string; title?: string };
  mdrag?: { enabled?: boolean; collectionId?: string; sourceGroup?: string };
  notion?: { enabled?: boolean; databaseId?: string; title?: string; mode?: "replace" | "append" };
  /**
   * The end user's own Drive, via Pattern Hunter's consent dance. Omitted for a
   * scheduled or API-driven run — see this module's docstring.
   */
  publishGDoc?: { user_id: string; title?: string };
};

/** `pattern-hunter-publish-gdoc`'s outcome, reported in the same vocabulary. */
export type PublishGDocDelivery =
  | { destination: "pattern-hunter-gdoc"; status: "delivered"; url: string; documentId: string }
  | { destination: "pattern-hunter-gdoc"; status: "skipped"; reason: string }
  | { destination: "pattern-hunter-gdoc"; status: "failed"; error: string };

export type PatternHunterDeliverResult = ReportDeliveryResult & {
  publishGDoc: PublishGDocDelivery;
};

export function patternHunterTitle(report: PatternHunterReport, date: string): string {
  return `Pattern Hunter — ${report.subject} (${date})`;
}

export const patternHunterDeliver = task({
  id: "pattern-hunter-deliver",
  retry: { maxAttempts: 1 },
  run: async (payload: PatternHunterDeliverPayload): Promise<PatternHunterDeliverResult> => {
    const { report } = payload;
    const date = payload.date ?? report.generated_at.slice(0, 10);

    const researchReport: ResearchReport = {
      workflow: "pattern-hunter",
      title: patternHunterTitle(report, date),
      subject: report.subject,
      date,
      generated_at: report.generated_at,
      // A report whose steps all completed is a completed report. A step that
      // failed is already visible as that step's own `status`/`error`, and the
      // rest of the report is still worth delivering.
      status: report.steps.some((s) => s.status === "failed") ? "failed" : "completed",
      steps: report.steps,
      ...(payload.ownerEmail ? { ownerEmail: payload.ownerEmail } : {}),
    };

    const markdown = renderReportMarkdown(researchReport);

    const delivery = await reportDeliver
      .triggerAndWait({
        report: researchReport,
        markdown,
        ...(payload.slack ? { slack: payload.slack } : {}),
        ...(payload.gdoc ? { gdoc: payload.gdoc } : {}),
        ...(payload.mdrag ? { mdrag: payload.mdrag } : {}),
        ...(payload.notion ? { notion: payload.notion } : {}),
      })
      .unwrap();

    const publishGDoc = await publishToUserDrive(payload, researchReport.title, markdown);

    logger.info("Pattern Hunter delivery complete", {
      subject: report.subject,
      delivered: delivery.deliveredCount,
      skipped: delivery.skippedCount,
      failed: delivery.failedCount,
      publishGDoc: publishGDoc.status,
    });

    return { ...delivery, publishGDoc };
  },
});

/**
 * Runs AFTER the three-destination batch rather than inside it, because it is a
 * fourth destination with a different identity model (see this module's
 * docstring). Its own failure is caught and reported rather than thrown: the
 * other three destinations already delivered by this point, and throwing would
 * discard a `ReportDeliveryResult` that is entirely valid.
 */
async function publishToUserDrive(
  payload: PatternHunterDeliverPayload,
  title: string,
  markdown: string
): Promise<PublishGDocDelivery> {
  if (!payload.publishGDoc?.user_id) {
    return {
      destination: "pattern-hunter-gdoc",
      status: "skipped",
      reason: "no publishGDoc.user_id — this run publishes to the workflow owner's Drive only",
    };
  }

  const result = await patternHunterPublishGDoc.triggerAndWait({
    user_id: payload.publishGDoc.user_id,
    title: payload.publishGDoc.title ?? title,
    markdown_content: markdown,
  });

  if (!result.ok) {
    const error = result.error instanceof Error ? result.error.message : JSON.stringify(result.error);
    logger.error("Pattern Hunter publish/gdoc failed", { error });
    return { destination: "pattern-hunter-gdoc", status: "failed", error };
  }

  if (result.output.status === "consent_required") {
    return {
      destination: "pattern-hunter-gdoc",
      status: "skipped",
      reason: `consent_required — send the user to ${result.output.consent_url} and re-trigger`,
    };
  }

  return {
    destination: "pattern-hunter-gdoc",
    status: "delivered",
    url: result.output.doc_url,
    documentId: result.output.doc_id,
  };
}
