import { schedules, logger, tags } from "@trigger.dev/sdk";
import { bluesDropResearch } from "./bluesDropResearch.js";
import { bluesDropDeliver } from "./bluesDropDeliver.js";
import type { BluesDropDeliverResult } from "./bluesDropDeliver.js";

/**
 * The weekly schedule entry point: research → deliver, and NOTHING else —
 * per `docs/ADR-002-research-seam-delivery-composition.md`'s composition
 * convention and its own "known gaps" audit finding, this is the single
 * most important file in trigger-dev-workflows#98 to get right. Three of
 * five workflows in this repo were once "documented as split but not
 * called" — the research/delivery halves existed, typechecked, and were
 * independently verified, but the entry point a scheduler actually invoked
 * still ran old inline logic (or, for a brand-new workflow like this one,
 * would have been trivial to leave unwired). `watchdog`'s version of that
 * gap caused a real incident (trigger-dev-workflows#43). This file exists
 * specifically so that never happens here: it does nothing but sequence.
 *
 * Replaces `indb_discordbot`'s `.github/workflows/drop-of-the-week.yml`
 * (cron `0 6 * * 1` — Mondays 6am UTC), which has been silently failing
 * since 2026-08-03 (the recurring GH Actions billing outage). That
 * workflow's schedule trigger is disabled in a companion change to
 * `indb_discordbot` once this is verified live, so the two never both fire.
 */

type SchedulePayload = {
  // A real `Date` when the scheduler invokes this task; a JSON string when
  // a human triggers it from the dashboard or API — the same `Date | string`
  // handling `crewRagDomoScrape.ts` and `infrastructureHealthReport.ts` both
  // need for the same reason (`schedules.task` payloads only carry a real
  // `Date` on the cron path).
  timestamp: Date | string;
  timezone: string;
  /** trigger-dev-workflows#101 — operator-forced topic-resolver mode
   * override, forwarded to `bluesDropResearch`'s own payload of the same
   * shape. Only meaningful on a manually-triggered test run from the
   * dashboard/API — the PRODUCTION cron trigger never sets this, so the
   * scheduled run always resolves the default weekly rotation (Denver radar
   * when a real show exists, artist-spotlight otherwise). */
  mode?: "artist" | "release" | "denver";
  /** Required together with `mode: "release"` — see `BluesDropResearchPayload`. */
  artist?: string;
  album?: string;
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

export type BluesDropFullRunResult = {
  status: "completed";
  weekId: string;
  topic: string;
  delivery: BluesDropDeliverResult;
};

export const bluesDropFullRun = schedules.task({
  id: "blues-drop-full-run",
  cron: {
    pattern: "0 6 * * 1",
    environments: ["PRODUCTION"],
  },
  // The orchestrator itself does not retry — research and deliver each
  // retry independently, and each is a clone+uv-sync+external-API call, not
  // cheap to blindly re-run as a pair.
  retry: { maxAttempts: 1 },
  maxDuration: 1200,
  run: async (payload: SchedulePayload): Promise<BluesDropFullRunResult> => {
    const timestamp = payload.timestamp instanceof Date ? payload.timestamp.toISOString() : String(payload.timestamp);
    logger.info("starting blues-drop-full-run", { timestamp, timezone: payload.timezone });
    await safeAddTags(["blues-drop", "indb-blues"]);

    // --- Research half ---
    const research = await bluesDropResearch
      .triggerAndWait({ mode: payload.mode, artist: payload.artist, album: payload.album })
      .unwrap();

    // --- Delivery half ---
    const delivery = await bluesDropDeliver.triggerAndWait(research).unwrap();

    logger.info("completed blues-drop-full-run", {
      weekId: research.weekId,
      topic: research.topic,
      delivered: delivery.deliveredCount,
      skipped: delivery.skippedCount,
      failed: delivery.failedCount,
    });

    return {
      status: "completed",
      weekId: research.weekId,
      topic: research.topic,
      delivery,
    };
  },
});
