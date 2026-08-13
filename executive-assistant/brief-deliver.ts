import { batch, task, logger } from "@trigger.dev/sdk";
import { synthesizeBrief } from "./tasks/synthesize-brief.js";
import { deliverSlack } from "./tasks/deliver-slack.js";
import { deliverDomoCanvas } from "./tasks/deliver-domo-canvas.js";
import { deliverGDoc } from "./tasks/deliver-gdoc.js";
import { deliverNotion } from "./tasks/deliver-notion.js";
import type { BriefResearch, DeliveryChannel, DeliveryReport } from "./lib/brief-delivery.js";

/**
 * The OUTPUT half of the morning brief: synthesize once, then fan out to every
 * destination in parallel.
 *
 * Takes `BriefResearch` and nothing else, so it is reusable by anything that
 * can produce that shape -- today `brief-research`, tomorrow a weekly digest.
 * It has no idea how the research was gathered.
 *
 * SYNTHESIZE ONCE, DELIVER FOUR TIMES. Each destination could render its own
 * brief, but then "the brief" quietly becomes four slightly different
 * documents. `synthesize-brief` runs here, and the destinations receive the
 * same markdown (Slack, Drive and Notion render it; Domo takes the structured
 * research instead -- see `tasks/deliver-domo-canvas.ts`).
 *
 * WHY `batch.triggerByTaskAndWait` AND NOT `Promise.all`. Wrapping
 * `triggerAndWait` in `Promise.all` is unsupported. The batch form is the
 * documented way to run DIFFERENT tasks concurrently and wait for all of them,
 * and it isolates failures: one destination throwing comes back as
 * `runs[i].ok === false` rather than rejecting the whole call, so a Domo outage
 * cannot cost you the Slack brief.
 *
 * WHY THE BATCH IS ALWAYS FOUR ENTRIES. `triggerByTaskAndWait` types its
 * result positionally, so a conditionally-shortened array loses per-destination
 * types. Instead every destination is always triggered and an unconfigured or
 * caller-disabled one returns `skipped` -- which also means the run history
 * shows, per morning, exactly which destinations were live and why the others
 * were not. Four no-op runs a day is a cheap price for that.
 *
 * WHY NOTION TAKES A TITLE AND MARKDOWN, NOT `BriefDeliveryBase`. It is the one
 * destination that needs nothing structural, so a single `deliver-notion` task
 * serves both this seam and `report-deliver`'s -- see that task's docstring.
 * The title doubles as Notion's upsert key, so `Morning Brief -- <date>` gives
 * one row per researched day, and a re-delivery rewrites that day's row rather
 * than adding a second one.
 */

export type BriefDeliverPayload = {
  research: BriefResearch;
  /**
   * Per-destination overrides. Omit a key entirely to use env defaults; set
   * `enabled: false` to skip that destination for this run only.
   */
  slack?: { enabled?: boolean; channel?: string };
  domo?: { enabled?: boolean; datasetId?: string; cardUrl?: string };
  gdoc?: {
    enabled?: boolean;
    ownerEmail?: string;
    documentId?: string;
    folderId?: string;
    title?: string;
  };
  notion?: {
    enabled?: boolean;
    databaseId?: string;
    title?: string;
    mode?: "replace" | "append";
    properties?: Record<string, unknown>;
  };
};

export type BriefDeliverResult = {
  date: string;
  briefMarkdown: string;
  deliveries: DeliveryReport[];
  deliveredCount: number;
  skippedCount: number;
  failedCount: number;
};

/** Trigger.dev surfaces a failed child's error as an unknown-ish object. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

function toReport(
  destination: DeliveryChannel,
  run: { ok: boolean; output?: unknown; error?: unknown }
): DeliveryReport {
  if (run.ok) return run.output as DeliveryReport;
  return { destination, status: "failed", error: errorMessage(run.error) };
}

export const briefDeliver = task({
  id: "brief-deliver",
  run: async (payload: BriefDeliverPayload): Promise<BriefDeliverResult> => {
    const { research } = payload;
    logger.info("starting brief-deliver", { date: research.date });

    const briefMarkdown = await synthesizeBrief
      .triggerAndWait({
        triageResults: research.triageResults,
        topicResults: research.topicResults,
      })
      .unwrap();

    const base = { research, briefMarkdown };
    const {
      runs: [slackRun, domoRun, gdocRun, notionRun],
    } = await batch.triggerByTaskAndWait([
      { task: deliverSlack, payload: { ...base, ...payload.slack } },
      { task: deliverDomoCanvas, payload: { ...base, ...payload.domo } },
      { task: deliverGDoc, payload: { ...base, ...payload.gdoc } },
      {
        task: deliverNotion,
        payload: {
          // The researched date, not today's -- the same reason
          // `deliver-slack` titles from `research.date`.
          title: `Morning Brief — ${research.date}`,
          markdown: briefMarkdown,
          ...payload.notion,
        },
      },
    ]);

    const deliveries: DeliveryReport[] = [
      toReport("slack", slackRun),
      toReport("domo", domoRun),
      toReport("gdoc", gdocRun),
      toReport("notion", notionRun),
    ];

    const result: BriefDeliverResult = {
      date: research.date,
      briefMarkdown,
      deliveries,
      deliveredCount: deliveries.filter((d) => d.status === "delivered").length,
      skippedCount: deliveries.filter((d) => d.status === "skipped").length,
      failedCount: deliveries.filter((d) => d.status === "failed").length,
    };

    // A failed destination does NOT fail this task -- the others already
    // delivered, and throwing here would retry them too. It is logged at
    // `error` so it still shows up as a problem rather than a footnote.
    for (const delivery of deliveries) {
      if (delivery.status === "failed") {
        logger.error("Brief delivery failed", {
          destination: delivery.destination,
          error: delivery.error,
        });
      }
    }
    logger.info("Brief delivery complete", {
      date: result.date,
      delivered: result.deliveredCount,
      skipped: result.skippedCount,
      failed: result.failedCount,
    });

    return result;
  },
});
