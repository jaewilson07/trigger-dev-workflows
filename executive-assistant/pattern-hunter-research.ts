import { task, logger, metadata } from "@trigger.dev/sdk";
import { patternHunterContextSnapshot } from "./tasks/pattern-hunter-context-snapshot.js";
import type { ContextSnapshotResult } from "./tasks/pattern-hunter-context-snapshot.js";
import { patternHunterPainPoints } from "./tasks/pattern-hunter-pain-points.js";
import type { PainPointsResult } from "./tasks/pattern-hunter-pain-points.js";
import { patternHunterHypotheses } from "./tasks/pattern-hunter-hypotheses.js";
import type { HypothesesResult } from "./tasks/pattern-hunter-hypotheses.js";
import { patternHunterRedTeam } from "./tasks/pattern-hunter-red-team.js";
import type { RedTeamResult } from "./tasks/pattern-hunter-red-team.js";
import { patternHunterBrief } from "./tasks/pattern-hunter-brief.js";
import type { BriefResult } from "./tasks/pattern-hunter-brief.js";
import type {
  Persona,
  PatternHunterReport,
  PatternHunterStep,
  WorkflowRunResult,
} from "./lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "./lib/pattern-hunter-types.js";

/**
 * The RESEARCH half of Pattern Hunter: Context Parser -> Pattern Scraper ->
 * Hypothesis Engine -> Red Team -> Final Packaging, producing a
 * `PatternHunterReport` and knowing nothing about where it goes.
 *
 * Lifted verbatim out of `pattern-hunter-full-run.ts`, which is now a 40-line
 * entry point that sequences this and `pattern-hunter-deliver`. Step 5 is
 * "Final Packaging" — it *packages*, it does not deliver, which is exactly why
 * the seam falls here. See `docs/pattern-hunter-rework.md`.
 *
 * The mapping design (why only steps 2 and 5 produce real `items`), the run
 * envelope, and the per-step metadata budget are all unchanged and documented
 * on `pattern-hunter-full-run.ts` and `lib/pattern-hunter-types.ts`.
 *
 * ## `metadata.root`, not `metadata.parent` — the one behavioural change
 *
 * The five node tasks used to append their finished step to `metadata.parent`,
 * which was correct while this orchestrator WAS the run a frontend subscribed
 * to. After the split their parent is THIS task and the subscribed run is
 * `pattern-hunter-full-run` one level up, so `.parent` would silently write
 * progress into a run nobody is watching — no thrown error, just a
 * step-reveal UI that quietly stops updating, while the report itself would
 * still be correct. See `docs/pattern-hunter-rework.md`'s "Decisions worth
 * defending" for the full writeup, and `tasks/deep-research-level.ts` for the
 * identical `.root`-vs-`.parent` distinction one level of nesting further in.
 * All five now use `metadata.root`, which resolves to `pattern-hunter-full-run`
 * when nested and to this task when it is triggered standalone. Both are the
 * run a viewer subscribed to, which is the property that actually matters.
 *
 * Consequence worth stating: when nested, THIS run's own metadata carries only
 * the envelope this task seeds and `current_step`; the `steps` array fills in
 * on the root run. A subscriber should watch the run it triggered, which is
 * what `useRealtimeRun` does anyway.
 */

const STEP_LABELS = [
  "Context Parser",
  "Pattern Scraper",
  "Hypothesis Engine",
  "Red Team",
  "Final Packaging",
] as const;

/**
 * No real intake-quiz wiring exists anywhere yet (see
 * `lib/pattern-hunter-types.ts`'s `Persona` doc comment for the full known
 * gap) — this is the clearly-labeled placeholder used when the caller doesn't
 * supply one.
 */
export const PLACEHOLDER_PERSONA: Persona = {
  role: "Operator",
  concerns: [],
  focus_areas: [],
  reference_urls: [],
};

export type PatternHunterResearchPayload = {
  business_input: string;
  /** Overrides the report's `industry` field. Defaults to `business_input`. */
  industry?: string;
  /** Optional caller-supplied persona — see `PLACEHOLDER_PERSONA`. */
  persona?: Persona;
};

export type PatternHunterResearch = {
  /**
   * `"failed"` the moment any step fails; `"completed"` only when all 5
   * finished. `report.steps` always reflects exactly what completed before that
   * point — never thrown away on a mid-chain failure.
   */
  status: "completed" | "failed";
  started_at: string;
  duration_ms: number;
  /**
   * Pinned to mdrag's exact wire contract (`subject`/`industry`/`persona`/
   * `generated_at`/`steps`) so `wiki.datacrew.space/pattern-hunter` keeps
   * working. Nothing about delivery leaks into it.
   */
  report: PatternHunterReport;
  /**
   * The day the research is ABOUT, `YYYY-MM-DD`, stamped once HERE and carried
   * through delivery — same reasoning as `BriefResearch.date`: a re-delivery
   * tomorrow should still title the day it researched.
   */
  date: string;
};

function failedStep(step: number, error: unknown, durationMs: number): PatternHunterStep {
  const message = error instanceof Error ? error.message : String(error);
  return {
    step,
    label: STEP_LABELS[step - 1] ?? `Step ${step}`,
    summary: `Step failed: ${message}`,
    status: "failed",
    items: [],
    duration_ms: durationMs,
    error: message,
  };
}

/**
 * Marks step `stepNumber` as the one now in flight, BEFORE its `triggerAndWait`
 * call — so a live subscriber sees "step 3/5 running" immediately, not only
 * once step 3's own task appends its finished entry.
 *
 * `metadata.root.set`, not `metadata.set`: after the split the run a viewer
 * subscribed to is `pattern-hunter-full-run`, one level up. See this module's
 * docstring.
 */
function publishStepStarted(stepNumber: number): void {
  metadata.root.set("current_step", stepNumber);
}

/**
 * Records a step that failed BEFORE it could construct+append its own entry (a
 * child that failed never reaches the point in its own `run()` where it builds
 * a `PatternHunterStep`). Only the orchestrator can observe "this child is
 * genuinely, finally failed" — after its own `retry.maxAttempts` is exhausted
 * and `triggerAndWait().unwrap()` throws — so only the orchestrator publishes
 * the failure; successful steps are published by the child that produced them.
 */
function publishStepFailed(step: PatternHunterStep): void {
  assertStepFitsMetadataBudget(step);
  metadata.root
    .set("status", "failed")
    .set("generated_at", new Date().toISOString())
    .append("steps", forMetadata(step));
}

export const patternHunterResearch = task({
  id: "pattern-hunter-research",
  // The orchestrator itself does NOT retry as a whole — each sub-task already
  // retries independently (maxAttempts: 2 apiece). Re-running the WHOLE chain
  // would re-fire already-succeeded steps' side effects (Letta messages billed
  // per call) for no benefit; a failure that survives its own sub-task's
  // retries is surfaced via `status: "failed"` instead of by throwing and
  // losing prior step results.
  retry: { maxAttempts: 1 },
  run: async (payload: PatternHunterResearchPayload, { ctx }): Promise<PatternHunterResearch> => {
    const businessInput = payload.business_input?.trim();
    if (!businessInput) {
      throw new Error("business_input is required");
    }
    const industry = payload.industry?.trim() || businessInput;
    const persona = payload.persona ?? PLACEHOLDER_PERSONA;
    logger.info("starting pattern-hunter-research", { businessInput, industry });

    const runStartedAt = ctx.run.startedAt;
    const date = runStartedAt.toISOString().slice(0, 10);

    const finish = (
      status: "completed" | "failed",
      steps: PatternHunterStep[]
    ): PatternHunterResearch => ({
      status,
      started_at: runStartedAt.toISOString(),
      duration_ms: Date.now() - runStartedAt.getTime(),
      report: {
        subject: businessInput,
        industry,
        persona,
        generated_at: new Date().toISOString(),
        steps,
      },
      date,
    });

    // Seed THIS run's own envelope so a standalone trigger of this task is
    // still subscribable. When nested under `pattern-hunter-full-run` that task
    // seeds its own identical envelope and the child steps land there instead
    // (see this module's docstring on `metadata.root`).
    metadata.replace(
      forMetadata({
        workflow: "pattern-hunter",
        input: payload,
        status: "running",
        generated_at: runStartedAt.toISOString(),
        steps: [],
      } satisfies WorkflowRunResult<PatternHunterResearchPayload>)
    );

    const steps: PatternHunterStep[] = [];

    // --- Step 1: Context Parser --------------------------------------------
    let contextSnapshot: ContextSnapshotResult;
    const step1Start = Date.now();
    publishStepStarted(1);
    try {
      contextSnapshot = await patternHunterContextSnapshot
        .triggerAndWait({ business_input: businessInput })
        .unwrap();
    } catch (err) {
      logger.error("pattern-hunter-context-snapshot failed", { businessInput, error: String(err) });
      const step = failedStep(1, err, Date.now() - step1Start);
      steps.push(step);
      publishStepFailed(step);
      return finish("failed", steps);
    }
    // The task already built + published its own step (metadata.root.append) —
    // just read it back, no re-derivation.
    steps.push(contextSnapshot.step);
    logger.info("context-snapshot complete", { businessInput });

    // Validation gate: if the context snapshot has no summary, the industry
    // context was empty — don't burn LLM tokens on step 2's mdrag search +
    // Letta call with nothing to ground on.
    if (!contextSnapshot.snapshot.summary?.trim()) {
      logger.warn("context-snapshot returned empty summary — skipping remaining steps", { businessInput });
      const skipStep = (n: number, label: string): PatternHunterStep => ({
        step: n,
        label,
        summary: "Skipped — prior step produced no usable output",
        status: "skipped" as const,
        items: [],
        duration_ms: 0,
      });
      for (let i = 2; i <= 5; i++) {
        const s = skipStep(i, STEP_LABELS[i - 1] ?? `Step ${i}`);
        steps.push(s);
        metadata.root.append("steps", forMetadata(s));
      }
      return finish("completed", steps);
    }

    // --- Step 2: Pattern Scraper --------------------------------------------
    let painPoints: PainPointsResult;
    const step2Start = Date.now();
    publishStepStarted(2);
    try {
      painPoints = await patternHunterPainPoints
        .triggerAndWait({
          business_input: businessInput,
          industry_snapshot: contextSnapshot.snapshot,
        })
        .unwrap();
    } catch (err) {
      logger.error("pattern-hunter-pain-points failed", { businessInput, error: String(err) });
      const step = failedStep(2, err, Date.now() - step2Start);
      steps.push(step);
      publishStepFailed(step);
      return finish("failed", steps);
    }
    steps.push(painPoints.step);
    logger.info("pain-points complete", {
      businessInput,
      nPainPoints: painPoints.pain_points.length,
      nEvidenceSources: painPoints.evidence_sources.length,
    });

    // Validation gate: if step 2 found no pain points AND no evidence
    // sources, there's nothing to generate hypotheses from — don't burn
    // LLM tokens on step 3's Letta call with empty input.
    if (painPoints.pain_points.length === 0 && painPoints.evidence_sources.length === 0) {
      logger.warn("pain-points returned 0 pain points and 0 evidence sources — skipping remaining steps", { businessInput });
      const skipStep = (n: number, label: string): PatternHunterStep => ({
        step: n,
        label,
        summary: "Skipped — prior step produced no usable output",
        status: "skipped" as const,
        items: [],
        duration_ms: 0,
      });
      for (let i = 3; i <= 5; i++) {
        const s = skipStep(i, STEP_LABELS[i - 1] ?? `Step ${i}`);
        steps.push(s);
        metadata.root.append("steps", forMetadata(s));
      }
      return finish("completed", steps);
    }

    // --- Step 3: Hypothesis Engine ------------------------------------------
    let hypotheses: HypothesesResult;
    const step3Start = Date.now();
    publishStepStarted(3);
    try {
      hypotheses = await patternHunterHypotheses
        .triggerAndWait({
          business_input: businessInput,
          pain_points: painPoints.pain_points,
          evidence_sources: painPoints.evidence_sources,
        })
        .unwrap();
    } catch (err) {
      logger.error("pattern-hunter-hypotheses failed", { businessInput, error: String(err) });
      const step = failedStep(3, err, Date.now() - step3Start);
      steps.push(step);
      publishStepFailed(step);
      return finish("failed", steps);
    }
    steps.push(hypotheses.step);
    logger.info("hypotheses complete", { businessInput, nCards: hypotheses.hypothesis_cards.length });

    // Validation gate: if step 3 generated no hypothesis cards, there's
    // nothing for red-team to evaluate or for the brief to package.
    if (hypotheses.hypothesis_cards.length === 0) {
      logger.warn("hypotheses returned 0 cards — skipping remaining steps", { businessInput });
      const skipStep = (n: number, label: string): PatternHunterStep => ({
        step: n,
        label,
        summary: "Skipped — prior step produced no usable output",
        status: "skipped" as const,
        items: [],
        duration_ms: 0,
      });
      for (let i = 4; i <= 5; i++) {
        const s = skipStep(i, STEP_LABELS[i - 1] ?? `Step ${i}`);
        steps.push(s);
        metadata.root.append("steps", forMetadata(s));
      }
      return finish("completed", steps);
    }

    // --- Step 4: Red Team ----------------------------------------------------
    let redTeam: RedTeamResult;
    const step4Start = Date.now();
    publishStepStarted(4);
    try {
      redTeam = await patternHunterRedTeam
        .triggerAndWait({
          business_input: businessInput,
          hypothesis_cards: hypotheses.hypothesis_cards,
        })
        .unwrap();
    } catch (err) {
      logger.error("pattern-hunter-red-team failed", { businessInput, error: String(err) });
      const step = failedStep(4, err, Date.now() - step4Start);
      steps.push(step);
      publishStepFailed(step);
      return finish("failed", steps);
    }
    const nPassed = redTeam.results.filter((r) => r.overall_pass).length;
    steps.push(redTeam.step);
    logger.info("red-team complete", { businessInput, nPassed, nTotal: redTeam.results.length });

    // --- Evaluator-Optimizer loop (between Red Team and Brief) ---------------
    //
    // When red-team fails hypotheses, feed the failure feedback back to the
    // hypothesis engine for regeneration, then re-run red-team. This is the
    // evaluator-optimizer pattern from the trigger-agents skill: generate →
    // evaluate → retry with feedback until approved (or max attempts).
    //
    // The loop modifies `hypotheses` and `redTeam` in place — step 5 (Brief)
    // reads from these variables, so whatever the loop produces is what the
    // brief packages. The step list and metadata are NOT touched here: the
    // revised hypotheses are visible in the brief step's output, not as
    // separate steps. This keeps the 5-step structure intact for viewers.
    const MAX_REVISION_ROUNDS = 2;
    const failedHypotheses = redTeam.results.filter((r) => !r.overall_pass);

    for (let round = 0; round < MAX_REVISION_ROUNDS && failedHypotheses.length > 0; round++) {
      logger.info("evaluator-optimizer: regenerating failed hypotheses", {
        businessInput,
        round: round + 1,
        nFailed: failedHypotheses.length,
        failedTitles: failedHypotheses.map((h) => h.hypothesis_title),
      });

      // Build feedback from failed hypotheses: which criteria failed and why.
      // NOTE: Pattern Hunter's POST /hypotheses endpoint does not currently
      // accept a feedback parameter — the loop re-runs generation with the
      // same inputs, which may produce different results due to LLM
      // non-determinism. When the API adds a feedback field, pass `feedback`
      // there. For now it's logged for observability.
      const feedback = failedHypotheses.map((h) => {
        const failedCriteria = h.criteria.filter((c) => !c.passed);
        return {
          hypothesis_title: h.hypothesis_title,
          failed_criteria: failedCriteria.map((c) => `${c.criterion}: ${c.rationale}`),
          replacement_recommendation: h.replacement_recommendation,
        };
      });
      logger.info("evaluator-optimizer: feedback for regeneration", { feedback });

      // Re-trigger hypothesis engine with feedback context
      try {
        const revisedHypotheses = await patternHunterHypotheses
          .triggerAndWait({
            business_input: businessInput,
            pain_points: painPoints.pain_points,
            evidence_sources: painPoints.evidence_sources,
          })
          .unwrap();

        // Re-run red-team on the revised hypotheses
        const revisedRedTeam = await patternHunterRedTeam
          .triggerAndWait({
            business_input: businessInput,
            hypothesis_cards: revisedHypotheses.hypothesis_cards,
          })
          .unwrap();

        // Check if we improved
        const newPassed = revisedRedTeam.results.filter((r) => r.overall_pass).length;
        logger.info("evaluator-optimizer: revision round complete", {
          round: round + 1,
          prevPassed: nPassed,
          newPassed,
          nTotal: revisedRedTeam.results.length,
        });

        // Adopt the revised results
        hypotheses = revisedHypotheses;
        redTeam = revisedRedTeam;
        failedHypotheses.length = 0;
        const stillFailed = revisedRedTeam.results.filter((r) => !r.overall_pass);
        failedHypotheses.push(...stillFailed);

        // If all pass now, break early
        if (failedHypotheses.length === 0) {
          logger.info("evaluator-optimizer: all hypotheses pass after revision", {
            round: round + 1,
          });
          break;
        }
      } catch (err) {
        logger.warn("evaluator-optimizer: revision round failed, keeping original hypotheses", {
          round: round + 1,
          error: String(err),
        });
        break;
      }
    }

    if (failedHypotheses.length > 0) {
      logger.warn("evaluator-optimizer: some hypotheses still fail after max rounds", {
        nStillFailed: failedHypotheses.length,
        maxRounds: MAX_REVISION_ROUNDS,
      });
    }

    // --- Step 5: Final Packaging ---------------------------------------------
    const step5Start = Date.now();
    publishStepStarted(5);
    let brief: BriefResult;
    try {
      brief = await patternHunterBrief
        .triggerAndWait({
          business_input: businessInput,
          industry_snapshot: contextSnapshot.snapshot,
          evidence_sources: painPoints.evidence_sources,
          pain_points: painPoints.pain_points,
          hypothesis_cards: hypotheses.hypothesis_cards,
          red_team_results: redTeam.results,
        })
        .unwrap();
    } catch (err) {
      logger.error("pattern-hunter-brief failed", { businessInput, error: String(err) });
      const step = failedStep(5, err, Date.now() - step5Start);
      steps.push(step);
      publishStepFailed(step);
      return finish("failed", steps);
    }
    steps.push(brief.step);
    logger.info("brief complete", {
      businessInput,
      answerFound: brief.answer_found,
      completeAnswerFound: brief.complete_answer_found,
      nRecommendations: brief.recommendations.length,
    });

    // All 5 steps finished. Only `publishStepFailed` ever flips the envelope to
    // "failed"; delivery flips it to "completed" at the very end of the run so
    // a subscriber doesn't see "completed" while destinations are still in
    // flight (see `pattern-hunter-full-run.ts`).
    return finish("completed", steps);
  },
});
