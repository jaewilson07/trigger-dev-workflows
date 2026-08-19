import { batch, task, logger } from "@trigger.dev/sdk";
import { deliverDiscord } from "./tasks/deliver-discord.js";
import { deliverNotion } from "./tasks/deliver-notion.js";
import { renderBluesDropMarkdown, renderBluesDropTitle, blueDropIsoDate } from "../lib/blues-drop-markdown.js";
import type {
  BluesDropDestination,
  BluesDropDeliveryReport,
  BluesDropResearch,
} from "../lib/blues-drop-types.js";

/**
 * The DELIVERY half of the Blues Drop of the Week: fan out to every
 * destination in parallel via `batch.triggerByTaskAndWait` — NOT
 * `Promise.all` (unsupported around `triggerAndWait`) and not a plain
 * `await deliverDiscord.triggerAndWait(...)` inline.
 *
 * The batch was shaped this way from #98 onward, at length one, specifically
 * so trigger-dev-workflows#99 (Notion, the second destination) would be "add
 * an array entry," not a restructure — `docs/ADR-002-research-seam-delivery-
 * composition.md`'s own audit found that three of five workflows in this
 * repo had a "documented as split but not called" gap, and restructuring a
 * delivery orchestrator from a single call into a fixed-length batch AFTER a
 * second destination already exists is exactly the kind of change that's
 * easy to get wrong under time pressure. #99 is that second entry: always
 * both, per ADR-002's fixed-length-batch rule — an unconfigured Notion
 * destination (no `NOTION_DATABASE_ID` on this environment yet, until the
 * database this issue creates is wired up) returns `skipped`, never gets
 * conditionally omitted from the array.
 *
 * Notion's markdown is rendered ONCE here (`lib/blues-drop-markdown.ts`),
 * not inside `deliver-notion` itself — that task takes title+markdown, not
 * `BluesDropResearch`, matching every other `deliver-notion` in this repo
 * (`docs/notion-delivery.md` §2). `deliver-discord` still renders its own
 * post from `research` directly, inside its Python subprocess — the two
 * destinations don't share a renderer because they don't share a runtime.
 */

export type BluesDropDeliverResult = {
  weekId: string;
  deliveries: BluesDropDeliveryReport[];
  deliveredCount: number;
  skippedCount: number;
  failedCount: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

function toReport(
  destination: BluesDropDestination,
  weekId: string,
  run: { ok: boolean; output?: unknown; error?: unknown }
): BluesDropDeliveryReport {
  if (run.ok) return run.output as BluesDropDeliveryReport;
  return { destination, status: "failed", weekId, error: errorMessage(run.error) };
}

export const bluesDropDeliver = task({
  id: "blues-drop-deliver",
  retry: { maxAttempts: 1 },
  run: async (research: BluesDropResearch): Promise<BluesDropDeliverResult> => {
    logger.info("starting blues-drop-deliver", { weekId: research.weekId, topic: research.topic });

    const notionPayload = {
      weekId: research.weekId,
      title: renderBluesDropTitle(research),
      markdown: renderBluesDropMarkdown(research),
      properties: {
        Week: { rich_text: [{ type: "text", text: { content: research.weekId } }] },
        Topic: { rich_text: [{ type: "text", text: { content: research.topic } }] },
        Date: { date: { start: blueDropIsoDate(research) } },
      },
    };

    const {
      runs: [discordRun, notionRun],
    } = await batch.triggerByTaskAndWait([
      { task: deliverDiscord, payload: research },
      { task: deliverNotion, payload: notionPayload },
    ]);

    const deliveries: BluesDropDeliveryReport[] = [
      toReport("discord", research.weekId, discordRun),
      toReport("notion", research.weekId, notionRun),
    ];

    const result: BluesDropDeliverResult = {
      weekId: research.weekId,
      deliveries,
      deliveredCount: deliveries.filter((d) => d.status === "delivered").length,
      skippedCount: deliveries.filter((d) => d.status === "skipped").length,
      failedCount: deliveries.filter((d) => d.status === "failed").length,
    };

    for (const delivery of deliveries) {
      if (delivery.status === "failed") {
        logger.error("blues-drop-deliver: destination failed", {
          destination: delivery.destination,
          error: delivery.error,
        });
      }
    }
    logger.info("blues-drop-deliver: complete", {
      weekId: result.weekId,
      delivered: result.deliveredCount,
      skipped: result.skippedCount,
      failed: result.failedCount,
    });

    return result;
  },
});
