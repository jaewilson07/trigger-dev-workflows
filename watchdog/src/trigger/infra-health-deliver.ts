import { batch, task, logger } from "@trigger.dev/sdk";
import { infraDeliverSlack } from "./tasks/infra-deliver-slack.js";
import { infraDeliverGDoc } from "./tasks/infra-deliver-gdoc.js";
import { infraDeliverNotion } from "./tasks/infra-deliver-notion.js";
import type { InfraHealthReport } from "../lib/infra-health.js";
import type { InfraChannel, InfraDeliveryReport } from "../lib/infra-delivery.js";

/**
 * The OUTPUT half of the infra health report: fan out to every destination in
 * parallel.
 *
 * Takes an `InfraHealthReport` and nothing else, so it is reusable by anything
 * that can produce that shape — and re-runnable, which is the practical win: a
 * report that was gathered successfully but hit a Slack outage can be
 * re-delivered without re-shelling-out to the host.
 *
 * WHY `batch.triggerByTaskAndWait` AND NOT `Promise.all`. Wrapping
 * `triggerAndWait` in `Promise.all` is unsupported. The batch form is the
 * documented way to run DIFFERENT tasks concurrently and wait for all of them,
 * and it isolates failures: one destination throwing comes back as
 * `runs[i].ok === false` rather than rejecting the whole call, so a Drive 403
 * cannot cost you the Slack alert. For a WATCHDOG that property is the point —
 * the one workflow whose job is to tell you something is broken should not be
 * the one that goes quiet when something is broken.
 *
 * WHY THE BATCH IS ALWAYS THREE ENTRIES. `triggerByTaskAndWait` types its
 * result positionally, so a conditionally shortened array loses
 * per-destination types. Every destination is always triggered and an
 * unconfigured one returns `skipped`, which also means the run history records
 * which destinations were live each day.
 *
 * WHY THREE AND NOT TWO. The three answer different questions — Slack "is
 * something broken right now", Drive "what did today's report say", Notion
 * "when did this first break" — and, for a watchdog specifically, they share
 * no vendor, token or network path, so an outage in one cannot silence the
 * other two. See `tasks/infra-deliver-notion.ts`.
 */

export type InfraHealthDeliverPayload = {
  report: InfraHealthReport;
  slack?: { enabled?: boolean; channel?: string };
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
  };
};

export type InfraHealthDeliverResult = {
  date: string;
  overallStatus: InfraHealthReport["overallStatus"];
  deliveries: InfraDeliveryReport[];
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
  destination: InfraChannel,
  run: { ok: boolean; output?: unknown; error?: unknown }
): InfraDeliveryReport {
  if (run.ok) return run.output as InfraDeliveryReport;
  return { destination, status: "failed", error: errorMessage(run.error) };
}

export const infraHealthDeliver = task({
  id: "infra-health-deliver",
  retry: { maxAttempts: 1 },
  run: async (payload: InfraHealthDeliverPayload): Promise<InfraHealthDeliverResult> => {
    const { report } = payload;

    const {
      runs: [slackRun, gdocRun, notionRun],
    } = await batch.triggerByTaskAndWait([
      { task: infraDeliverSlack, payload: { report, ...payload.slack } },
      { task: infraDeliverGDoc, payload: { report, ...payload.gdoc } },
      { task: infraDeliverNotion, payload: { report, ...payload.notion } },
    ]);

    const deliveries: InfraDeliveryReport[] = [
      toReport("slack", slackRun),
      toReport("gdoc", gdocRun),
      toReport("notion", notionRun),
    ];

    const result: InfraHealthDeliverResult = {
      date: report.date,
      overallStatus: report.overallStatus,
      deliveries,
      deliveredCount: deliveries.filter((d) => d.status === "delivered").length,
      skippedCount: deliveries.filter((d) => d.status === "skipped").length,
      failedCount: deliveries.filter((d) => d.status === "failed").length,
    };

    // A failed destination does NOT fail this task — the others may well have
    // delivered, and throwing here would retry them too.
    for (const delivery of deliveries) {
      if (delivery.status === "failed") {
        logger.error("infra-health-deliver: destination failed", {
          destination: delivery.destination,
          error: delivery.error,
        });
      }
    }
    logger.info("infra-health-deliver: complete", {
      date: result.date,
      overallStatus: result.overallStatus,
      delivered: result.deliveredCount,
      skipped: result.skippedCount,
      failed: result.failedCount,
    });

    return result;
  },
});
