import { task, logger } from "@trigger.dev/sdk";
import { reportDeliver } from "./report-deliver.js";
import { renderReportMarkdown } from "./lib/render-report.js";
import type { PatternHunterStep } from "./lib/pattern-hunter-types.js";
import type { ReportDeliveryResult, ResearchReport } from "./lib/report-delivery.js";

/**
 * The OUTPUT half of Deep Researcher: turn a finished recursion into the
 * project-wide `ResearchReport` seam and hand it to `report-deliver`.
 *
 * AN ADAPTER, NOT A SECOND FAN-OUT — the parallel `batch.triggerByTaskAndWait`
 * lives once, in `report-deliver.ts`. See `pattern-hunter-deliver.ts`, which is
 * the same shape; the two differ only in how they title the document and in
 * Pattern Hunter's extra end-user-Drive destination, which has no Deep
 * Researcher equivalent.
 *
 * ## Why this workflow needed almost no adapting
 *
 * Deep Researcher already returns `WorkflowRunResult<DeepResearcherPayload>` —
 * `steps: PatternHunterStep[]`, one per recursion level plus a Final Report
 * step whose `narrative` holds the synthesized prose, with each level's
 * evidence as `EvidenceResult` items carrying real source URLs. That is exactly
 * what `ResearchReport.steps` is typed to, so the seam needed no new shape:
 * `lib/render-report.ts` renders a level's evidence as cited bullets and the
 * Final Report's narrative as prose without knowing which workflow produced
 * either. The audit called this workflow "the most sophisticated research
 * composition in the repo with zero destinations" — the destinations were the
 * only missing piece, not the data model.
 *
 * ## Re-delivery
 *
 * Because this takes `steps` rather than a run id, re-publishing a completed
 * research run to a destination that was misconfigured at the time costs one
 * seconds-long trigger against the stored steps, instead of re-running a
 * depth-3 recursion's worth of mdrag primitive calls.
 */

export type DeepResearcherDeliverPayload = {
  /** What was researched — becomes the document title and subject. */
  topic: string;
  /** The finished recursion's steps, verbatim from `deep-researcher-full-run`. */
  steps: PatternHunterStep[];
  status?: "completed" | "failed";
  /** `YYYY-MM-DD` the research is about. Defaults to today at the delivery. */
  date?: string;
  generated_at?: string;
  ownerEmail?: string;
  slack?: { enabled?: boolean; channel?: string };
  gdoc?: { enabled?: boolean; ownerEmail?: string; documentId?: string; folderId?: string; title?: string };
  mdrag?: { enabled?: boolean; collectionId?: string; sourceGroup?: string };
  notion?: { enabled?: boolean; databaseId?: string; title?: string; mode?: "replace" | "append" };
};

export const deepResearcherDeliver = task({
  id: "deep-researcher-deliver",
  retry: { maxAttempts: 1 },
  run: async (payload: DeepResearcherDeliverPayload): Promise<ReportDeliveryResult> => {
    const topic = payload.topic?.trim();
    if (!topic) {
      throw new Error("topic is required");
    }
    logger.info("starting deep-researcher-deliver", { topic });

    const generated_at = payload.generated_at ?? new Date().toISOString();
    const date = payload.date ?? generated_at.slice(0, 10);

    const report: ResearchReport = {
      workflow: "deep-researcher",
      title: `Deep Research — ${topic} (${date})`,
      subject: topic,
      date,
      generated_at,
      status: payload.status ?? (payload.steps.some((s) => s.status === "failed") ? "failed" : "completed"),
      steps: payload.steps,
      ...(payload.ownerEmail ? { ownerEmail: payload.ownerEmail } : {}),
    };

    const delivery = await reportDeliver
      .triggerAndWait({
        report,
        markdown: renderReportMarkdown(report),
        ...(payload.slack ? { slack: payload.slack } : {}),
        ...(payload.gdoc ? { gdoc: payload.gdoc } : {}),
        ...(payload.mdrag ? { mdrag: payload.mdrag } : {}),
        ...(payload.notion ? { notion: payload.notion } : {}),
      })
      .unwrap();

    logger.info("Deep Researcher delivery complete", {
      topic,
      delivered: delivery.deliveredCount,
      skipped: delivery.skippedCount,
      failed: delivery.failedCount,
    });

    return delivery;
  },
});
