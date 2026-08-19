import { batch, task, logger } from "@trigger.dev/sdk";
import { deliverDiscord } from "./tasks/deliver-discord.js";
import type {
  BluesDropDestination,
  BluesDropDeliveryReport,
  BluesDropResearch,
} from "../lib/blues-drop-types.js";

/**
 * The DELIVERY half of the Blues Drop of the Week: fan out to every
 * destination in parallel via `batch.triggerByTaskAndWait` — NOT
 * `Promise.all` (unsupported around `triggerAndWait`) and not a plain
 * `await deliverDiscord.triggerAndWait(...)` inline, even though this issue
 * only wires one destination.
 *
 * The batch shape (rather than a direct call) is deliberate even at length
 * one: trigger-dev-workflows#99 adds a second destination on top of this
 * same task, and `docs/ADR-002-research-seam-delivery-composition.md`'s own
 * audit found that three of five workflows in this repo had a
 * "documented as split but not called" gap — the fix there was cheap
 * per-task, but restructuring a delivery orchestrator from a single call
 * into a fixed-length batch AFTER a second destination already exists is the
 * kind of change that's easy to get wrong under time pressure. Shaping this
 * as a batch now, while there is only one entry to reason about, costs
 * nothing and means #99 only adds an array entry.
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

    const {
      runs: [discordRun],
    } = await batch.triggerByTaskAndWait([{ task: deliverDiscord, payload: research }]);

    const deliveries: BluesDropDeliveryReport[] = [
      toReport("discord", research.weekId, discordRun),
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
