import { task, logger, metadata } from "@trigger.dev/sdk";
import { stormResearch } from "./storm-research.js";
import { stormDeliver } from "./storm-deliver.js";
import type { StormDeliverResult } from "./storm-deliver.js";
import type {
  OutputDestination,
  StormResearch,
  StormRunProgress,
} from "./lib/storm-types.js";

/**
 * storm-research-full-run — the entry point for the STORM workflow: research
 * -> deliver.
 *
 * A THIN SEQUENCER, per `docs/ADR-002-research-seam-delivery-composition.md`.
 * Steps 1-5 (perspectives, interviews, contradictions, synthesis, the
 * verify/revise loop) live in `storm-research.ts` and return a structured
 * `StormResearch`; rendering and the parallel fan-out to every destination
 * live in `storm-deliver.ts`. This file used to inline both halves, which left
 * `storm-research` and `storm-deliver` typechecking but never called, and the
 * fan-out sequential. Same failure as morning-brief (trigger-dev-workflows#54).
 *
 * STORM (Synthesis of Topic Outlines through Retrieval and Multi-perspective
 * question asking) — Stanford OVAL lab method, backed by Letta Cloud agents.
 *
 * ## Usage
 *
 * Trigger from the dashboard's Test tab on `storm-research-full-run`:
 *   {"topic": "The impact of AI agents on enterprise data engineering"}
 *
 * Optional fields:
 *   customPerspectives: ["security", "legal", "ethics"] — add custom lenses
 *   maxRevisionRounds: 2 — max verify→revise loops (default 2)
 *   slackChannel: "user:U08L4B485B4" — where to post the briefing
 *   slackUserId: "U08L4B485B4" — DM target + Google Doc share target
 *   outputs: ["slack_briefing", "slack_md", "mdrag"] — delivery destinations
 *   userEmail: "jae@datacrew.space" — identity for the resolved mdrag
 *     Conversation (#51); defaults to MORNING_BRIEF_USER_EMAIL, this repo's
 *     established single-operator identity default (see letta-fallback.ts,
 *     conversation-agent.ts, brief-research.ts)
 */

export type StormResearchPayload = {
  topic: string;
  /** Custom perspective lenses in addition to the 5 defaults. */
  customPerspectives?: string[];
  /** Max verify→revise loops. Default 2. */
  maxRevisionRounds?: number;
  /** Slack channel to post the briefing to. Defaults to a DM to slackUserId. */
  slackChannel?: string;
  /** Slack user ID — used to DM the user and to share the Google Doc with them. */
  slackUserId?: string;
  /** Where to deliver the finished report. Default: see `storm-deliver`. */
  outputs?: OutputDestination[];
  /**
   * Identity of the triggering user, for resolving/creating this run's own
   * mdrag Conversation (#51). Defaults to MORNING_BRIEF_USER_EMAIL.
   */
  userEmail?: string;
};

export type StormResearchResult = {
  run_id: string;
  started_at: string;
  duration_ms: number;
  /**
   * The structured research, returned so a destination that was misconfigured
   * at the time can be re-delivered by triggering `storm-deliver` with it,
   * instead of re-running hours of Letta interviews.
   */
  research: StormResearch;
  /** Absent only when delivery itself died; the research is still returned. */
  delivery?: StormDeliverResult;
};

const STEP_LABELS = [
  "Discover Perspectives",
  "Conduct Interviews",
  "Map Contradictions",
  "Synthesize Report",
  "Verify Sources",
  "Prepare Report",
  "Deliver Outputs",
];

export const stormResearchFullRun = task({
  id: "storm-research-full-run",
  // The orchestrator does not retry -- research and deliver each retry
  // independently; re-running the whole chain would re-bill every interview.
  retry: { maxAttempts: 1 },
  run: async (payload: StormResearchPayload, { ctx }): Promise<StormResearchResult> => {
    logger.info("starting storm-research-full-run");

    const topic = payload.topic?.trim();
    if (!topic) {
      throw new Error("topic is required");
    }

    const runStartedAt = ctx.run.startedAt;

    // Seed live progress. The research task's children write `current_step`
    // to `metadata.root`, which resolves to THIS run when nested.
    metadata.replace({
      workflow: "storm-research",
      input: { topic },
      status: "running",
      generated_at: runStartedAt.toISOString(),
      current_step: 1,
      total_steps: STEP_LABELS.length,
      step_labels: STEP_LABELS,
    } satisfies StormRunProgress);

    // --- Research half ---
    const research = await stormResearch
      .triggerAndWait({
        topic,
        customPerspectives: payload.customPerspectives,
        maxRevisionRounds: payload.maxRevisionRounds,
        userEmail: payload.userEmail,
      })
      .unwrap();

    metadata.set("current_step", 6);

    // --- Delivery half ---
    //
    // A delivery task that dies outright must not discard the research: it is
    // hours of work and `research` is exactly what re-delivery needs.
    let delivery: StormDeliverResult | undefined;
    try {
      delivery = await stormDeliver
        .triggerAndWait({
          research,
          ...(payload.outputs ? { outputs: payload.outputs } : {}),
          ...(payload.slackChannel ? { slackChannel: payload.slackChannel } : {}),
          ...(payload.slackUserId ? { slackUserId: payload.slackUserId } : {}),
        })
        .unwrap();
    } catch (err) {
      logger.error("storm-research-full-run: delivery failed; research is still returned", {
        topic,
        error: String(err),
      });
    }

    metadata.set("status", "completed").set("generated_at", new Date().toISOString());

    logger.info("completed storm-research-full-run", {
      delivered: delivery?.deliveredCount,
      skipped: delivery?.skippedCount,
      failed: delivery?.failedCount,
    });

    return {
      run_id: ctx.run.id,
      started_at: runStartedAt.toISOString(),
      duration_ms: Date.now() - runStartedAt.getTime(),
      research,
      ...(delivery ? { delivery } : {}),
    };
  },
});
