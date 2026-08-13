import { schedules, logger, tags } from "@trigger.dev/sdk";
import { infraHealthResearch } from "./infra-health-research.js";
import { infraHealthDeliver } from "./infra-health-deliver.js";
import type { InfraHealthDeliverResult } from "./infra-health-deliver.js";

/**
 * The entry point for the daily infra health report: research → deliver.
 *
 * This is a THIN SEQUENCER — the three-check research fan-out lives in
 * `infra-health-research.ts` and the three-destination delivery fan-out
 * lives in `infra-health-deliver.ts`. This file does nothing but trigger
 * one after the other, per `docs/ADR-002-research-seam-delivery-composition.md`'s
 * repo-wide composition pattern.
 *
 * ## Why this file used to do everything inline, and doesn't anymore
 *
 * `docs/watchdog-rework.md` decomposed this exact monolith on 2026-08-05
 * (`InfraHealthReport` as the seam, `infra-health-research`/
 * `infra-health-deliver` as the two halves, both independently verified
 * live) — but its own "Blocked" section records that THIS entry point could
 * not reach its children at the time: a bot-gate 403'd its `triggerAndWait`
 * calls, and the doc's own stated fallback (option 2) was to leave this
 * file as the pre-rework monolith so the daily report kept running while
 * the gate stayed broken. The gate was fixed 2026-08-07
 * (`infra-bonker@ee5cdd0`, see `AGENTS.md`), but nobody circled back to
 * finish the decomposition here — this file stayed the monolith for five
 * more days, still doing its own `execFile`/`docker ps`/raw Slack POST
 * inline. That is the direct, confirmed cause of
 * `jaewilson07/trigger-dev-workflows#43` ("no COMPLETED runs in last 100
 * attempts"): the trigger.dev worker container has no host Docker socket
 * or CLI access, so `execFile` throws uncaught inside the monolith's one
 * unguarded function — whereas `check-cli-drift.ts`/`check-service-groups.ts`
 * (the decomposed replacements, wired below) already catch exactly that
 * and report `unknown` rows instead of crashing the whole task.
 */

type SchedulePayload = {
  // A real `Date` when the scheduler invokes this task; a JSON string when a
  // human triggers it from the dashboard or API. The pre-rework monolith
  // called `payload.timestamp.toISOString()` directly and crashed with
  // "toISOString is not a function" on every manual run — the exact defect
  // `docs/watchdog-rework.md` documents fixing, and the exact defect this
  // rewrite (2026-08-12, closing #43) briefly reintroduced by not carrying
  // the `Date | string` handling over. Normalize via `new Date(...)` before
  // calling any Date method.
  timestamp: Date | string;
  timezone: string;
};

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    console.warn(
      "Skipping Trigger.dev tags outside managed runtime:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export type InfrastructureHealthReportResult = {
  status: "completed";
  date: string;
  overallStatus: InfraHealthDeliverResult["overallStatus"];
  delivery: InfraHealthDeliverResult;
};

export const infrastructureHealthReport = schedules.task({
  id: "infrastructure-health-report",
  cron: {
    pattern: "0 14 * * *",
    environments: ["PRODUCTION"],
  },
  // The orchestrator itself does not retry — research and deliver each
  // retry independently. Re-running the whole thing would re-shell-out to
  // the host and re-post to every destination for no benefit.
  retry: { maxAttempts: 1 },
  run: async (payload: SchedulePayload): Promise<InfrastructureHealthReportResult> => {
    const timestamp = new Date(payload.timestamp).toISOString();
    logger.info("starting infrastructure-health-report", {
      timestamp,
      timezone: payload.timezone,
    });
    await safeAddTags(["infra", "health", "bonker", "cubby"]);

    // --- Research half ---
    const report = await infraHealthResearch.triggerAndWait({}).unwrap();

    // --- Delivery half ---
    const delivery = await infraHealthDeliver.triggerAndWait({ report }).unwrap();

    logger.info("completed infrastructure-health-report", {
      date: report.date,
      overallStatus: report.overallStatus,
      delivered: delivery.deliveredCount,
      skipped: delivery.skippedCount,
      failed: delivery.failedCount,
    });

    return {
      status: "completed",
      date: report.date,
      overallStatus: delivery.overallStatus,
      delivery,
    };
  },
});
