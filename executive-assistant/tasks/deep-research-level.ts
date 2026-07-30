import { task, logger, metadata } from "@trigger.dev/sdk";
import { mdragPlanResearch } from "./mdrag-plan-research.js";
import { deepResearchQuery } from "./deep-research-query.js";
import type { DeepResearchQueryResult } from "./deep-research-query.js";
import type { EvidenceResult, PatternHunterStep } from "../lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "../lib/pattern-hunter-types.js";

/**
 * datacrew#336 — one recursion LEVEL of the Deep Researcher workflow: plan
 * this level's queries, run each one (`deep-research-query.ts`), then
 * recurse into the next level using this level's follow-up questions as the
 * next level's seed — the "follow-up questions from one level becoming the
 * next level's queries, learnings accumulating across levels" shape the
 * issue describes, modeled on Trigger.dev's `vercel-ai-sdk-deep-research-agent`
 * example (`docs/guides/example-projects/vercel-ai-sdk-deep-research.mdx` in
 * the trigger.dev repo): `breadth` queries per level, halving each
 * recursion, follow-ups feeding the next level, learnings accumulating.
 *
 * This is its own `task()` — recursively self-triggered via `triggerAndWait`
 * from `deep-researcher-full-run.ts` (level 1) and from ITSELF (level 2+) —
 * so every recursion level is its own Trigger.dev run with its own timing
 * and retry behavior, individually visible in the dashboard (the issue's
 * "recursion depth must be visible as progress" AC), distinct from
 * `deep-research-query.ts`'s per-QUERY visibility within a level.
 *
 * ## Live progress: `metadata.root`, not `metadata.parent`
 *
 * `pattern-hunter-*.ts` tasks push their finished step onto the run's live
 * envelope via `metadata.parent.append(...)` — safe there because every
 * Pattern Hunter step task is called directly by the ONE orchestrator a
 * viewer subscribes to, so "parent" and "the run being watched" are the same
 * run. That does not hold here: a level-3 task's immediate PARENT is a
 * level-2 task, not `deep-researcher-full-run`'s own run — `metadata.parent`
 * from inside a nested level would silently write to an intermediate level's
 * run instead of the root a viewer actually subscribed to. `metadata.root`
 * (confirmed against `@trigger.dev/core`'s `RunMetadataManager`/
 * `RunMetadataUpdater` types and `runs/metadata.mdx`'s "Parent & root
 * updates" section: "root = the initial task that was triggered externally")
 * exists exactly for this — it always resolves to the top-level orchestrator
 * regardless of how deep this task is nested, so every level's step lands in
 * the SAME envelope a viewer is watching.
 *
 * ## Failure handling — mirrors `search-providers`' own hydration_error degrade
 *
 * Both an individual query's failure (`deepResearchQuery.batchTriggerAndWait`)
 * and a deeper level's failure (`deepResearchLevel.batchTriggerAndWait`) are
 * TOLERATED here, not thrown: logged loudly (this repo's no-silent-failures
 * convention — see `mdrag`'s own `hydrate_envelope`/`hydration_error`
 * precedent for "keep whatever succeeded, surface what didn't, never throw
 * away partial progress") and recorded as their own visible step/absence,
 * while every sibling query/branch that DID succeed still contributes its
 * evidence and learnings. This is what the issue's "a step failing
 * mid-recursion leaves prior levels' findings intact and visible" AC asks
 * for: a failure narrows what this run learned, it never erases what it
 * already found. The only way `deepResearchLevel` itself throws is if
 * `plan-research` — this level's own first call, with nothing yet to lose —
 * exhausts its retries; that propagates up to whichever caller triggered
 * THIS level (another `deepResearchLevel`'s batch, or the top orchestrator's
 * own try/catch), which handles it exactly the same way.
 */

export type DeepResearchLevelPayload = {
  /** This level's seed query — the raw topic at level 1, or a synthesized
   * "previous query + its follow-up questions" string at a deeper level (see
   * the recursion call below). */
  query: string;
  /** The overall, unchanging research topic — threaded through unchanged so
   * every level's `critique` call (inside `deep-research-query.ts`) judges
   * relevance against the ORIGINAL research intent, not this level's
   * possibly-drifted `query` text. */
  researchTopic: string;
  /** 1-indexed recursion depth. */
  level: number;
  /** Recursion levels still to run, INCLUDING this one — recursion into
   * level+1 only happens while `depthRemaining > 1`. */
  depthRemaining: number;
  /** Number of queries to plan and pursue at THIS level. */
  breadth: number;
};

export type DeepResearchLevelResult = {
  level: number;
  /** Every evidence item found at THIS level and every descendant level
   * (accumulates across the whole subtree rooted here). */
  evidence: EvidenceResult[];
  /** Every learning extracted at THIS level and every descendant level. */
  learnings: string[];
  /** THIS level's own step only — see `allSteps` for the full subtree. */
  step: PatternHunterStep;
  /** This level's own `step` plus every descendant level's/failed-level's
   * step, THIS level first followed by each recursive branch in the order
   * `batchTriggerAndWait` returned its results — lets
   * `deep-researcher-full-run.ts` reconstruct its own return value's
   * `steps` list without re-deriving anything (same "read it back, no
   * re-derivation" principle `pattern-hunter-full-run.ts` already follows
   * for its own child tasks' `step` fields). NOT guaranteed to match the
   * REAL-TIME order steps landed in `metadata.root` — sibling branches at
   * the same depth run concurrently, so their `metadata.root.append` calls
   * can interleave in whatever order each branch actually finishes in. Fine
   * for this field's purpose (the top orchestrator's own terminal return
   * value only needs a complete, correctly-shaped list once the whole run
   * is done); a viewer wanting the true live arrival order should read
   * `run.metadata.steps` itself, not this returned array. */
  allSteps: PatternHunterStep[];
};

/** Mirrors the trigger.dev example's "breadth halved each level", floored at
 * 1 so recursion never fully starves out before `depthRemaining` does. */
function nextBreadth(breadth: number): number {
  return Math.max(1, Math.ceil(breadth / 2));
}

function failedLevelStep(level: number, error: unknown): PatternHunterStep {
  const message = error instanceof Error ? error.message : String(error);
  return {
    step: level,
    label: `Research level ${level}`,
    summary: `Level ${level} failed: ${message}`,
    status: "failed",
    items: [],
    error: message,
  };
}

export const deepResearchLevel = task({
  id: "deep-research-level",
  // This level's own children (mdrag-plan-research directly, plus every
  // deep-research-query / deeper deep-research-level fanned out below)
  // already retry independently. Retrying this WHOLE level on an
  // orchestrator-style top-level retry would re-fire every already-succeeded
  // query's mdrag primitive calls for no benefit — same reasoning
  // `pattern-hunter-full-run.ts` gives for its own `retry.maxAttempts: 1`.
  retry: { maxAttempts: 1 },
  run: async (payload: DeepResearchLevelPayload): Promise<DeepResearchLevelResult> => {
    const { query, researchTopic, level, depthRemaining, breadth } = payload;
    const start = Date.now();

    const plan = await mdragPlanResearch.triggerAndWait({ topic: query }).unwrap();
    const queries = (plan.subquestions.length > 0 ? plan.subquestions : [query]).slice(0, breadth);

    logger.info("deep-research-level: queries planned", { level, depthRemaining, breadth, queries });

    // Fan out this level's queries concurrently — each is its own
    // deep-research-query run, individually visible/retried in the
    // dashboard. Tolerate a single query's failure (logged, not thrown) so
    // one bad search doesn't take out the whole level's findings.
    const queryBatch = await deepResearchQuery.batchTriggerAndWait(
      queries.map((q) => ({ payload: { query: q, researchTopic, level } }))
    );

    const queryResults: DeepResearchQueryResult[] = [];
    let nFailedQueries = 0;
    for (const run of queryBatch.runs) {
      if (run.ok) {
        queryResults.push(run.output);
      } else {
        nFailedQueries += 1;
        logger.error("deep-research-level: a query failed; continuing with the remaining queries", {
          level,
          error: String(run.error),
        });
      }
    }

    const ownEvidence = queryResults.flatMap((r) => r.evidence);
    const ownLearnings = queryResults.flatMap((r) => r.learnings);

    const step: PatternHunterStep = {
      step: level,
      label: `Research level ${level}`,
      summary:
        `${queries.length} ${queries.length === 1 ? "query" : "queries"} at level ${level}` +
        (nFailedQueries > 0 ? ` (${nFailedQueries} failed)` : "") +
        `, ${ownEvidence.length} evidence items, ${ownLearnings.length} learnings gathered`,
      status: "done",
      items: ownEvidence,
      duration_ms: Date.now() - start,
      narrative: queryResults.map((r) => r.synthesis).filter(Boolean).join("\n\n") || undefined,
    };

    assertStepFitsMetadataBudget(step);
    metadata.root.set("generated_at", new Date().toISOString()).append("steps", forMetadata(step));

    let allEvidence = ownEvidence;
    let allLearnings = ownLearnings;
    let allSteps: PatternHunterStep[] = [step];

    const recursable = queryResults.filter((r) => r.followUpQuestions.length > 0);
    if (depthRemaining > 1 && recursable.length > 0) {
      const childBreadth = nextBreadth(breadth);
      const levelBatch = await deepResearchLevel.batchTriggerAndWait(
        recursable.map((r) => ({
          payload: {
            query: `${r.query}\n\nFollow-up questions:\n${r.followUpQuestions.join("\n")}`,
            researchTopic,
            level: level + 1,
            depthRemaining: depthRemaining - 1,
            breadth: childBreadth,
          },
        }))
      );

      for (const run of levelBatch.runs) {
        if (run.ok) {
          allEvidence = allEvidence.concat(run.output.evidence);
          allLearnings = allLearnings.concat(run.output.learnings);
          allSteps = allSteps.concat(run.output.allSteps);
        } else {
          logger.error(
            "deep-research-level: a deeper recursion level failed; this and every prior level's findings remain intact",
            { failedLevel: level + 1, error: String(run.error) }
          );
          const failStep = failedLevelStep(level + 1, run.error);
          assertStepFitsMetadataBudget(failStep);
          metadata.root.set("generated_at", new Date().toISOString()).append("steps", forMetadata(failStep));
          allSteps = allSteps.concat([failStep]);
        }
      }
    }

    return { level, evidence: allEvidence, learnings: allLearnings, step, allSteps };
  },
});
