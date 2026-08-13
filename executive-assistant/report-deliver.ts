import { batch, task, logger } from "@trigger.dev/sdk";
import { reportSlack } from "./tasks/report-slack.js";
import { reportGDoc } from "./tasks/report-gdoc.js";
import { reportMdrag } from "./tasks/report-mdrag.js";
import { deliverNotion } from "./tasks/deliver-notion.js";
import { renderReportMarkdown } from "./lib/render-report.js";
import type {
  ReportChannel,
  ReportDeliveryReport,
  ReportDeliveryResult,
  ResearchReport,
} from "./lib/report-delivery.js";

/**
 * The OUTPUT half for every research workflow in this project that isn't the
 * morning brief: render once, then fan out to every destination in parallel.
 *
 * Takes a `ResearchReport` and nothing else, so it is reusable by anything that
 * can produce that shape — today `pattern-hunter-deliver` and
 * `deep-researcher-deliver`, tomorrow whatever comes next. It has no idea how
 * the research was gathered.
 *
 * This is `brief-deliver.ts` with a different seam, and deliberately so — same
 * always-N-entry batch, same `delivered | skipped | failed` vocabulary, same
 * "a failed destination is logged, not thrown". See that file's doc comment for
 * the full reasoning; the three points worth restating:
 *
 * RENDER ONCE, DELIVER FOUR TIMES. Each destination could render its own
 * report, but then "the report" quietly becomes four slightly different
 * documents. `renderReportMarkdown` runs here; Slack additionally builds Block
 * Kit from the same structured `steps[]` rather than from the markdown, because
 * Slack does not speak GitHub-flavored markdown (`lib/render-report.ts`).
 *
 * WHY `batch.triggerByTaskAndWait` AND NOT `Promise.all`. Wrapping
 * `triggerAndWait` in `Promise.all` is unsupported. The batch form is the
 * documented way to run DIFFERENT tasks concurrently and wait for all of them,
 * and it isolates failures: one destination throwing comes back as
 * `runs[i].ok === false` rather than rejecting the whole call.
 *
 * WHY THE BATCH IS ALWAYS FOUR ENTRIES. `triggerByTaskAndWait` types its
 * result positionally, so a conditionally-shortened array loses per-destination
 * types. Every destination is always triggered and an unconfigured or
 * caller-disabled one returns `skipped`, which also means the run history
 * records exactly which destinations were live and why the others were not.
 *
 * WHY NOTION IS THE ONE DESTINATION SHARED WITH `brief-deliver`. The other
 * three come in seam-specific pairs (`report-slack` vs `deliver-slack`, and so
 * on) because they need the structure — Block Kit per step, mdrag's document
 * shape. Notion needs only a title and markdown, both of which this seam
 * already has, so `deliver-notion` serves both halves of the project unchanged.
 * The title is also Notion's upsert key, and `ResearchReport.title` already
 * carries the run's date, so each research run gets its own row.
 */

export type ReportDeliverPayload = {
  report: ResearchReport;
  /**
   * Pre-rendered markdown. Almost always omitted — supplied only when a caller
   * has already rendered the exact bytes it wants delivered (a re-delivery of
   * an archived document, say) and re-rendering could produce something
   * subtly different.
   */
  markdown?: string;
  /** Per-destination overrides. Omit a key for env defaults; `enabled: false` skips. */
  slack?: { enabled?: boolean; channel?: string };
  gdoc?: {
    enabled?: boolean;
    ownerEmail?: string;
    documentId?: string;
    folderId?: string;
    title?: string;
  };
  mdrag?: { enabled?: boolean; collectionId?: string; sourceGroup?: string };
  notion?: {
    enabled?: boolean;
    databaseId?: string;
    title?: string;
    mode?: "replace" | "append";
    properties?: Record<string, unknown>;
  };
};

/** Trigger.dev surfaces a failed child's error as an unknown-ish object. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

function toReport(
  destination: ReportChannel,
  run: { ok: boolean; output?: unknown; error?: unknown }
): ReportDeliveryReport {
  if (run.ok) return run.output as ReportDeliveryReport;
  return { destination, status: "failed", error: errorMessage(run.error) };
}

export const reportDeliver = task({
  id: "report-deliver",
  run: async (payload: ReportDeliverPayload): Promise<ReportDeliveryResult> => {
    const { report } = payload;
    logger.info("starting report-deliver", { workflow: report.workflow, title: report.title });
    const markdown = payload.markdown ?? renderReportMarkdown(report);

    const base = { report, markdown };
    const {
      runs: [slackRun, gdocRun, mdragRun, notionRun],
    } = await batch.triggerByTaskAndWait([
      { task: reportSlack, payload: { ...base, ...payload.slack } },
      { task: reportGDoc, payload: { ...base, ...payload.gdoc } },
      { task: reportMdrag, payload: { ...base, ...payload.mdrag } },
      {
        task: deliverNotion,
        payload: { title: report.title, markdown, ...payload.notion },
      },
    ]);

    const deliveries: ReportDeliveryReport[] = [
      toReport("slack", slackRun),
      toReport("gdoc", gdocRun),
      toReport("mdrag", mdragRun),
      toReport("notion", notionRun),
    ];

    const result: ReportDeliveryResult = {
      workflow: report.workflow,
      title: report.title,
      date: report.date,
      markdown,
      deliveries,
      deliveredCount: deliveries.filter((d) => d.status === "delivered").length,
      skippedCount: deliveries.filter((d) => d.status === "skipped").length,
      failedCount: deliveries.filter((d) => d.status === "failed").length,
    };

    // A failed destination does NOT fail this task — the others already
    // delivered, and throwing here would retry them too. Logged at `error` so
    // it shows up as a problem rather than a footnote.
    for (const delivery of deliveries) {
      if (delivery.status === "failed") {
        logger.error("Report delivery failed", {
          workflow: report.workflow,
          destination: delivery.destination,
          error: delivery.error,
        });
      }
    }
    logger.info("Report delivery complete", {
      workflow: report.workflow,
      delivered: result.deliveredCount,
      skipped: result.skippedCount,
      failed: result.failedCount,
    });

    return result;
  },
});
