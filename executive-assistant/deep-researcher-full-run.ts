import { task, logger, metadata } from "@trigger.dev/sdk";
import { deepResearchLevel } from "./tasks/deep-research-level.js";
import { mdragSynthesize } from "./tasks/mdrag-synthesize.js";
import type { SynthesisFinding } from "./tasks/mdrag-synthesize.js";
import type { PatternHunterStep, WorkflowRunResult } from "./lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "./lib/pattern-hunter-types.js";

/**
 * datacrew#336 — a second Trigger.dev workflow: a recursive deep-research
 * agent backed entirely by mdrag's `/api/v1/primitives` router (all five
 * routes confirmed live — `plan-research`/`search-providers`/`critique`/
 * `synthesize`/`extract-results`), modeled on Trigger.dev's own
 * `vercel-ai-sdk-deep-research-agent` example but with every OpenAI/Exa call
 * replaced by the matching mdrag primitive (see the issue's own mapping
 * table). No new paid vendor dependency.
 *
 * `research-primitives-demo.ts` (datacrew#298) was the skeleton this slice
 * builds on top of: it chains plan-research -> synthesize -> extract-results
 * with NO retrieval step (its own module docstring says so explicitly). This
 * workflow adds the retrieval (`search-providers` + `critique`, in
 * `tasks/deep-research-query.ts`) and the recursion (`tasks/deep-research-level.ts`)
 * — depth x breadth, breadth halving each level, follow-up questions from one
 * level becoming the next level's queries, learnings accumulating across
 * levels, exactly the shape the trigger.dev example describes.
 *
 * ## Envelope reuse (datacrew#332) — structural verification only
 *
 * This task's live progress (`metadata`) and its own return value both use
 * `WorkflowRunResult` (`lib/pattern-hunter-types.ts`, added by #332
 * SPECIFICALLY so this workflow could reuse it) with `workflow:
 * "deep-researcher"` and this task's own payload as `input` — NO new,
 * parallel envelope type is declared anywhere in this slice. Per that type's
 * own doc comment, `TStep` defaults to `PatternHunterStep`, which this
 * workflow also reuses unchanged: `items` holds `EvidenceResult`s (the
 * existing `evidence` `PatternResult` variant — search hits map onto it with
 * no new type, "headline, verbatim quote, source name and URL are exactly
 * what a search result carries," per the issue) and `narrative` carries this
 * workflow's prose (a level's combined query syntheses, and the final
 * report's body) — `narrative` exists on `PatternHunterStep` in the first
 * place BECAUSE #332 anticipated "the future Deep Researcher workflow (#336,
 * whose steps are prose-first rather than item-list-first)" needing it (see
 * that field's own doc comment).
 *
 * The acceptance criterion this CANNOT satisfy yet: "the same envelope shape
 * as Pattern Hunter — verified by the existing UI rendering it with no
 * workflow-specific code." That UI is datacrew#335, being built in parallel
 * and not yet merged as of this PR — there is nothing running yet for this
 * envelope to be rendered BY. Verified STRUCTURALLY instead, by reusing
 * `WorkflowRunResult`/`PatternHunterStep`/`EvidenceResult` verbatim rather
 * than redeclaring a parallel shape (this file, `tasks/deep-research-level.ts`,
 * and `tasks/deep-research-query.ts` import every one of those three types
 * from `lib/pattern-hunter-types.ts`, never define their own). UI-level
 * verification is explicitly pending #335 — see this PR's description.
 *
 * ## Cost bound
 *
 * Recursion multiplies mdrag primitive calls: each level's `breadth` queries
 * each cost 4 primitive calls (search-providers/critique/synthesize/
 * extract-results) plus 1 for that level's own `plan-research`, and each of
 * those `breadth` queries can spawn its OWN next level. `clampDepthBreadth`
 * below computes the exact worst-case total for the requested depth/breadth
 * BEFORE a single mdrag call is made and clamps down (breadth first, depth
 * only if still over) to fit `MAX_TOTAL_PRIMITIVE_CALLS` — logged every run
 * (`logger.info`), and LOUDLY (`logger.warn`, with the requested vs. clamped
 * values) whenever the requested depth/breadth actually gets reduced. Per
 * this repo's no-silent-failures convention: a silent cap here would make a
 * narrowed run look, from the outside, like it searched everything the
 * caller asked for.
 *
 * ## Deployment note
 *
 * This repo's deployed Trigger.dev image is plain Node — no Python. Nothing
 * in this slice touches `lib/python.ts` (which only works under local
 * `trigger dev`); every mdrag call goes over `lib/mdrag-primitives.ts`'s
 * plain `fetch`-based HTTP client, same as `research-primitives-demo.ts` and
 * `pattern-hunter-full-run.ts` already do.
 */

export type DeepResearcherPayload = {
  topic: string;
  /** Recursion depth (number of levels). Defaults to `DEFAULT_DEPTH`;
   * clamped — see `clampDepthBreadth`. */
  depth?: number;
  /** Queries pursued at level 1 (halved each deeper level). Defaults to
   * `DEFAULT_BREADTH`; clamped — see `clampDepthBreadth`.
   *
   * IGNORED when `queries` is supplied — an explicit query list IS the
   * breadth, and honouring both would let the two silently disagree. */
  breadth?: number;
  /**
   * Round 1's queries, decided by the CALLER instead of by `plan-research`.
   *
   * The query-expansion step was always there — `tasks/deep-research-level.ts`
   * calls `plan-research` and consumes its subquestions a line later — but it
   * happened mid-run, invisibly, and its output varied enough between runs to
   * make the same topic behave very differently on two attempts. This field
   * lets that decision be hoisted in front of the run and approved by a human
   * first (the planning conversation in pattern-hunter-web's `/api/plan`),
   * which is the point: what we choose to look for is the most consequential
   * decision in a research run, and it should not be the one nobody sees.
   *
   * ONLY round 1. Deeper rounds still plan themselves from the follow-up
   * questions the round above actually raised — those aren't knowable in
   * advance, so there is nothing for a human to approve there.
   */
  queries?: string[];
};

/**
 * The run's final return value: `WorkflowRunResult` itself (this workflow's
 * live envelope, resolved) plus the run-identity fields
 * `pattern-hunter-full-run.ts`'s own `PatternHunterFullRunResult` also adds
 * alongside its envelope (`run_id`/`started_at`/`duration_ms`) — same
 * reasoning: distinct, genuinely useful facts about the RUN itself, not
 * duplicated by the generic envelope. An intersection, not a redeclaration —
 * `WorkflowRunResult`'s own shape is untouched.
 */
export type DeepResearcherFullRunResult = WorkflowRunResult<DeepResearcherPayload> & {
  run_id: string;
  started_at: string;
  duration_ms: number;
};

const DEFAULT_DEPTH = 2;
const DEFAULT_BREADTH = 2;

// Hard per-field ceilings, independent of the total-call budget below — no
// caller can ask for e.g. depth=50 even if MAX_TOTAL_PRIMITIVE_CALLS were
// somehow raised later.
const MAX_DEPTH = 4;
const MAX_BREADTH = 5;

const CALLS_PER_QUERY = 4; // search-providers + critique + synthesize + extract-results
const CALLS_PER_LEVEL_OVERHEAD = 1; // that level's own plan-research

/**
 * Upper bound on total mdrag primitive calls across the WHOLE recursive run,
 * generous relative to the DEFAULT_DEPTH/DEFAULT_BREADTH combination (19
 * calls — see `totalPrimitiveCalls`'s own doc comment) so ordinary use is
 * nowhere near it, but tight enough that a caller-requested depth/breadth
 * that would compound into hundreds of calls gets clamped instead of run to
 * completion.
 */
const MAX_TOTAL_PRIMITIVE_CALLS = 60;

/**
 * Deterministic, side-effect-free upper bound on mdrag primitive calls for a
 * full recursive run at the given depth/breadth (breadth halved,
 * `Math.ceil(breadth / 2)` floored at 1, each level down — mirrors
 * `deep-research-level.ts`'s own `nextBreadth`). NEVER exceeded by a real
 * run: `deep-research-level.ts` only ever plans `min(breadth,
 * subquestions.length)` queries and only recurses for queries that actually
 * produced follow-up questions, so this is always an upper bound, never an
 * underestimate. Must be computable BEFORE a single mdrag call is made — see
 * `clampDepthBreadth`.
 *
 * DEFAULT_DEPTH=2, DEFAULT_BREADTH=2 example: level 1 costs
 * `1 + 2*4 = 9` calls and spawns 2 level-2 branches (breadth
 * `ceil(2/2)=1` each); each level-2 branch costs `1 + 1*4 = 5` calls; total
 * `9 + 2*5 = 19`.
 */
function totalPrimitiveCalls(depth: number, breadth: number): number {
  if (depth <= 0) return 0;
  const thisLevel = CALLS_PER_LEVEL_OVERHEAD + breadth * CALLS_PER_QUERY;
  if (depth === 1) return thisLevel;
  return thisLevel + breadth * totalPrimitiveCalls(depth - 1, Math.max(1, Math.ceil(breadth / 2)));
}

/**
 * Clamps caller-supplied depth/breadth to (a) the hard per-field ceilings
 * and (b) `MAX_TOTAL_PRIMITIVE_CALLS`, reducing breadth first (narrows one
 * level's width — cheaper to lose) and only then depth (removes a whole
 * recursion tier — more expensive to lose) until `totalPrimitiveCalls` fits
 * the budget. Always logs the resulting bound (`logger.info`); logs LOUDLY
 * (`logger.warn`, with both the requested and clamped values) whenever
 * clamping actually changed anything — see this module's docstring, "Cost
 * bound" section, for why silence here would be a defect, not a convenience.
 */
function clampDepthBreadth(requestedDepth: number, requestedBreadth: number): { depth: number; breadth: number } {
  let depth = Math.max(1, Math.min(MAX_DEPTH, Math.round(requestedDepth) || DEFAULT_DEPTH));
  let breadth = Math.max(1, Math.min(MAX_BREADTH, Math.round(requestedBreadth) || DEFAULT_BREADTH));

  if (depth !== requestedDepth || breadth !== requestedBreadth) {
    logger.warn("deep-researcher-full-run: requested depth/breadth clamped to per-field ceilings", {
      requestedDepth,
      requestedBreadth,
      clampedDepth: depth,
      clampedBreadth: breadth,
      MAX_DEPTH,
      MAX_BREADTH,
    });
  }

  const requestedEstimate = totalPrimitiveCalls(depth, breadth);
  let estimate = requestedEstimate;
  while (estimate > MAX_TOTAL_PRIMITIVE_CALLS && breadth > 1) {
    breadth -= 1;
    estimate = totalPrimitiveCalls(depth, breadth);
  }
  while (estimate > MAX_TOTAL_PRIMITIVE_CALLS && depth > 1) {
    depth -= 1;
    estimate = totalPrimitiveCalls(depth, breadth);
  }

  if (estimate !== requestedEstimate) {
    logger.warn(
      "deep-researcher-full-run: depth/breadth clamped to stay within MAX_TOTAL_PRIMITIVE_CALLS",
      {
        MAX_TOTAL_PRIMITIVE_CALLS,
        requestedEstimatedCalls: requestedEstimate,
        clampedDepth: depth,
        clampedBreadth: breadth,
        clampedEstimatedCalls: estimate,
      }
    );
  }

  logger.info("deep-researcher-full-run: primitive-call bound applied", {
    depth,
    breadth,
    estimatedPrimitiveCalls: estimate,
    MAX_TOTAL_PRIMITIVE_CALLS,
  });

  return { depth, breadth };
}

function failedRunStep(error: unknown, durationMs: number): PatternHunterStep {
  const message = error instanceof Error ? error.message : String(error);
  return {
    step: 1,
    label: "Round 1",
    summary: `Round 1 failed: ${message}`,
    status: "failed",
    items: [],
    duration_ms: durationMs,
    error: message,
  };
}

/**
 * Trigger this from the trigger.dev dashboard's "Test" tab on
 * `deep-researcher-full-run`, payload `{"topic": "..."}` (optionally
 * `{"depth": N, "breadth": N}` — both clamped, see `clampDepthBreadth`) — one
 * `deep-research-level` child run per recursion level, each fanning out one
 * `deep-research-query` child run per query at that level, all individually
 * visible with their own timing/retries, satisfying the issue's "recursion
 * depth must be visible as progress" AC.
 *
 * Subscribe to THIS run's live progress the same way
 * `pattern-hunter-full-run.ts` documents (`useRealtimeRun`/
 * `runs.subscribeToRun`, reading `run.metadata` as a
 * `WorkflowRunResult<DeepResearcherPayload>`) — `current_step` is set to `1`
 * before level 1 starts and to `depth + 1` before the final report
 * synthesizes, a best-effort signal only: unlike Pattern Hunter's strictly
 * linear 5-step chain, this workflow's levels below the root can run several
 * branches concurrently (`deep-research-level.ts`'s own
 * `batchTriggerAndWait` fan-out), so one scalar `current_step` cannot
 * precisely name "the" step in flight once recursion branches — the
 * `steps` array (each level's own step, appended by
 * `deep-research-level.ts`/`deep-research-query.ts` the moment it finishes)
 * is the precise, per-branch signal a subscriber should actually render.
 *
 * STRUCTURAL VERIFICATION ONLY as of this PR — same situation
 * `research-primitives-demo.ts`/`pattern-hunter-full-run.ts` were in: this
 * task has never been pushed to a live Trigger.dev instance, and this
 * sandbox has no network access to `wiki.datacrew.space` (mdrag) or a
 * running Trigger.dev dev server. A genuine end-to-end run — trigger this
 * task for real, watch `deep-research-level`/`deep-research-query` child
 * runs appear and `run.metadata` update live, confirm real mdrag search
 * results become evidence with real URLs — was NOT performed and could not
 * have been from here. What WAS verified: `npm run typecheck` (see this PR's
 * description for the result) and every mdrag `/api/v1/primitives` request/
 * response shape below was read directly from mdrag's own source
 * (`src/interfaces/api/routers/primitives/{models,router}.py`,
 * `src/providers/models.py`), not guessed.
 */
export const deepResearcherFullRun = task({
  id: "deep-researcher-full-run",
  // See tasks/deep-research-level.ts's own retry.maxAttempts comment — same
  // reasoning propagated one level further up: every child (level 1's own
  // deep-research-level run, and everything IT fans out) already retries
  // independently.
  retry: { maxAttempts: 1 },
  run: async (payload: DeepResearcherPayload, { ctx }): Promise<DeepResearcherFullRunResult> => {
    const topic = payload.topic?.trim();
    if (!topic) {
      throw new Error("topic is required");
    }

    const runStartedAt = ctx.run.startedAt;

    // An approved query list IS round 1's breadth — see `queries`' own doc
    // comment. Feeding `payload.breadth` into the cost bound while ALSO
    // running a longer `queries` list would under-count the run and blow
    // straight past MAX_TOTAL_PRIMITIVE_CALLS, so the list's own length is
    // what gets clamped.
    const approvedQueries = (payload.queries ?? []).map((q) => q.trim()).filter(Boolean);
    const requestedBreadth =
      approvedQueries.length > 0 ? approvedQueries.length : (payload.breadth ?? DEFAULT_BREADTH);

    const { depth, breadth } = clampDepthBreadth(payload.depth ?? DEFAULT_DEPTH, requestedBreadth);

    // Clamping can cut the list shorter than what the user actually approved.
    // Dropping approved queries silently would be the worst version of this
    // whole feature: the user reviews a plan, agrees to it, and the run
    // quietly does less than they signed off on.
    const queries = approvedQueries.slice(0, breadth);
    if (queries.length < approvedQueries.length) {
      logger.warn(
        "deep-researcher-full-run: the approved query list was cut to fit the primitive-call budget; the run will NOT cover every approved vector",
        { nApproved: approvedQueries.length, nRunning: queries.length, depth, breadth, dropped: approvedQueries.slice(breadth) }
      );
    }
    if (queries.length > 0) {
      logger.info("deep-researcher-full-run: running caller-approved round 1 queries instead of plan-research", {
        topic,
        queries,
      });
    }

    // Seed the live run envelope (datacrew#332's WorkflowRunResult, reused
    // verbatim) BEFORE level 1 starts — same `.replace()` + `satisfies`
    // pattern `pattern-hunter-full-run.ts` uses, for the same reason: the
    // one place this shape is checked against the compiler.
    metadata.replace(
      forMetadata({
        workflow: "deep-researcher",
        input: payload,
        status: "running",
        generated_at: runStartedAt.toISOString(),
        steps: [],
      } satisfies WorkflowRunResult<DeepResearcherPayload>)
    );
    metadata.set("current_step", 1);

    const step1Start = Date.now();
    let level1;
    try {
      level1 = await deepResearchLevel
        .triggerAndWait({
          query: topic,
          researchTopic: topic,
          level: 1,
          depthRemaining: depth,
          breadth,
          ...(queries.length > 0 ? { queries } : {}),
        })
        .unwrap();
    } catch (err) {
      logger.error("deep-researcher-full-run: level 1 failed", { topic, error: String(err) });
      const step = failedRunStep(err, Date.now() - step1Start);
      assertStepFitsMetadataBudget(step);
      metadata.set("status", "failed").set("generated_at", new Date().toISOString()).append("steps", forMetadata(step));
      return {
        workflow: "deep-researcher",
        input: payload,
        status: "failed",
        generated_at: new Date().toISOString(),
        steps: [step],
        run_id: ctx.run.id,
        started_at: runStartedAt.toISOString(),
        duration_ms: Date.now() - runStartedAt.getTime(),
      };
    }

    logger.info("deep-researcher-full-run: recursion complete", {
      topic,
      depth,
      breadth,
      nEvidence: level1.evidence.length,
      nLearnings: level1.learnings.length,
    });

    // Final report — "LLM writes the report" -> synthesize, per the issue's
    // mapping table — over every learning accumulated across every level,
    // not just level 1's own. The narrative lands on the step's `narrative`
    // field per the issue's "final report reaches the step narrative field"
    // AC.
    const reportStepStart = Date.now();
    metadata.set("current_step", depth + 1);

    let narrative = "";
    if (level1.learnings.length > 0) {
      const findings: SynthesisFinding[] = level1.learnings.map((claim) => ({ claim, source_url: "" }));
      try {
        const synthesized = await mdragSynthesize.triggerAndWait({ topic, findings }).unwrap();
        narrative = synthesized.synthesis;
      } catch (err) {
        logger.error(
          "deep-researcher-full-run: final report synthesis failed; returning recursion results without a narrative",
          { topic, error: String(err) }
        );
      }
    } else {
      logger.warn(
        "deep-researcher-full-run: no learnings accumulated across any recursion level; skipping final report synthesis",
        { topic, depth, breadth }
      );
    }

    const reportStep: PatternHunterStep = {
      step: depth + 1,
      label: "Final Report",
      summary: narrative
        ? `Final report synthesized from ${level1.learnings.length} accumulated learnings`
        : "No final report — no learnings were accumulated, or synthesis failed",
      status: narrative ? "done" : "failed",
      items: [],
      duration_ms: Date.now() - reportStepStart,
      ...(narrative ? { narrative } : { error: "no learnings accumulated / synthesis failed" }),
    };

    assertStepFitsMetadataBudget(reportStep);
    metadata.set("status", "completed").set("generated_at", new Date().toISOString()).append("steps", forMetadata(reportStep));

    return {
      workflow: "deep-researcher",
      input: payload,
      status: "completed",
      generated_at: new Date().toISOString(),
      // level1.allSteps is a complete, correctly-shaped reconstruction of
      // every level's own step (not necessarily in real-time metadata
      // arrival order — see DeepResearchLevelResult.allSteps's own doc
      // comment for why concurrent sibling branches make that unordered).
      steps: [...level1.allSteps, reportStep],
      run_id: ctx.run.id,
      started_at: runStartedAt.toISOString(),
      duration_ms: Date.now() - runStartedAt.getTime(),
    };
  },
});
