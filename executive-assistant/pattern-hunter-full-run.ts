import { task, logger, metadata } from "@trigger.dev/sdk";
import { patternHunterResearch } from "./pattern-hunter-research.js";
import type { PatternHunterResearch, PatternHunterResearchPayload } from "./pattern-hunter-research.js";
import { patternHunterDeliver } from "./pattern-hunter-deliver.js";
import type { PatternHunterDeliverPayload, PatternHunterDeliverResult } from "./pattern-hunter-deliver.js";
import type { Persona, WorkflowRunResult } from "./lib/pattern-hunter-types.js";
import { forMetadata } from "./lib/pattern-hunter-types.js";

/**
 * The entry point for a full Pattern Hunter run: research → deliver.
 *
 * This is a THIN ORCHESTRATOR — the 5-step research chain lives in
 * `pattern-hunter-research.ts` and the delivery fan-out lives in
 * `pattern-hunter-deliver.ts` (via `report-deliver.ts`). This file just
 * sequences the two halves and seeds the live run envelope so a subscriber
 * sees progress from the research steps as they happen.
 *
 * ## Why this file exists separately from research
 *
 * `pattern-hunter-research` can be triggered standalone (e.g. from a
 * browser that wants the structured report without delivery). This task
 * adds the delivery half and is the one a scheduled run or API caller
 * triggers for a complete end-to-end run.
 *
 * ## Live progress metadata
 *
 * This task seeds the `WorkflowRunResult` envelope before triggering
 * research. The research task's child tasks append their steps to
 * `metadata.root`, which resolves to THIS run when nested — so a
 * subscriber watching this run sees steps fill in as each completes.
 * See `pattern-hunter-research.ts`'s docstring on `metadata.root` for
 * the full reasoning.
 */

export type PatternHunterFullRunPayload = PatternHunterResearchPayload & {
  /** Delivery configuration — passed through to pattern-hunter-deliver. */
  slack?: PatternHunterDeliverPayload["slack"];
  gdoc?: PatternHunterDeliverPayload["gdoc"];
  mdrag?: PatternHunterDeliverPayload["mdrag"];
  notion?: PatternHunterDeliverPayload["notion"];
  publishGDoc?: PatternHunterDeliverPayload["publishGDoc"];
  /** Google identity to publish as. */
  ownerEmail?: string;
};

export type PatternHunterFullRunResult = {
  run_id: string;
  status: "completed" | "failed";
  started_at: string;
  duration_ms: number;
  research: PatternHunterResearch;
  delivery?: PatternHunterDeliverResult;
};

export const patternHunterFullRun = task({
  id: "pattern-hunter-full-run",
  // The orchestrator itself does NOT retry — research and deliver each
  // retry independently. Re-running the whole thing would re-fire
  // already-succeeded steps' side effects for no benefit.
  retry: { maxAttempts: 1 },
  run: async (
    payload: PatternHunterFullRunPayload,
    { ctx }
  ): Promise<PatternHunterFullRunResult> => {
    const { slack, gdoc, mdrag, notion, publishGDoc, ownerEmail, ...researchPayload } = payload;

    // Seed the live run envelope so a subscriber sees progress as it happens.
    metadata.replace(
      forMetadata({
        workflow: "pattern-hunter",
        input: payload,
        status: "running",
        generated_at: ctx.run.startedAt.toISOString(),
        steps: [],
      } satisfies WorkflowRunResult<PatternHunterFullRunPayload>)
    );

    // --- Research half ---
    const research = await patternHunterResearch
      .triggerAndWait(researchPayload)
      .unwrap();

    // Update the envelope status — research is done, delivery is next.
    metadata.set("status", research.status === "completed" ? "running" : "failed");

    if (research.status === "failed") {
      logger.info("pattern-hunter research failed — skipping delivery", {
        businessInput: researchPayload.business_input,
      });
      metadata.set("generated_at", new Date().toISOString());
      return {
        run_id: ctx.run.id,
        status: "failed",
        started_at: ctx.run.startedAt.toISOString(),
        duration_ms: Date.now() - ctx.run.startedAt.getTime(),
        research,
      };
    }

    // --- Delivery half ---
    let delivery: PatternHunterDeliverResult | undefined;
    try {
      delivery = await patternHunterDeliver
        .triggerAndWait({
          report: research.report,
          date: research.date,
          ...(ownerEmail ? { ownerEmail } : {}),
          ...(slack ? { slack } : {}),
          ...(gdoc ? { gdoc } : {}),
          ...(mdrag ? { mdrag } : {}),
          ...(notion ? { notion } : {}),
          ...(publishGDoc ? { publishGDoc } : {}),
        })
        .unwrap();
    } catch (err) {
      // Delivery failure doesn't erase the research — return what we have.
      logger.error("pattern-hunter delivery failed", {
        businessInput: researchPayload.business_input,
        error: String(err),
      });
    }

    // Flip the envelope to completed — delivery (if attempted) is done.
    metadata.set("status", "completed").set("generated_at", new Date().toISOString());

    return {
      run_id: ctx.run.id,
      status: delivery ? "completed" : "failed",
      started_at: ctx.run.startedAt.toISOString(),
      duration_ms: Date.now() - ctx.run.startedAt.getTime(),
      research,
      delivery,
    };
  },
});
