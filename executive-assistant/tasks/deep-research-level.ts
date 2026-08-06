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
  /**
   * Pre-decided queries for THIS level, bypassing `plan-research` entirely.
   * Set only for round 1, by a caller who had the plan approved by a human
   * first (see `DeepResearcherPayload.queries`). Deeper rounds always plan
   * themselves, because their queries come from follow-up questions that
   * don't exist until the round above has run.
   *
   * NOT recursed into children — a child level receives no `queries` and so
   * falls back to planning, which is the intended behaviour, not an
   * oversight.
   */
  queries?: string[];
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

/**
 * The step appended for level `level + 1` when THIS level decides not to
 * recurse into it — see the `recursable.length === 0` branch below.
 *
 * Exists because "the caller asked for depth N, and level N never ran" is a
 * real outcome with a real reason, not an absence. Before this, a depth=3 run
 * whose queries raised no follow-up questions simply never wrote a level-3
 * step, and the UI — which pre-declares one row per requested level — left
 * that row on "Waiting…" forever, on a run that had already COMPLETED. A
 * viewer could not distinguish "still working" from "finished, and this level
 * was never needed." Emitting an explicit `skipped` step with the actual
 * reason is the no-silent-failures answer: the plan (depth N) and what
 * actually happened stay both visible, and the gap between them is explained
 * where it's noticed rather than only in this task's `logger.warn`.
 */
function skippedLevelStep(level: number, reason: string): PatternHunterStep {
  return {
    step: level,
    label: `Round ${level}`,
    summary: reason,
    status: "skipped",
    items: [],
  };
}

function failedLevelStep(level: number, error: unknown): PatternHunterStep {
  const message = error instanceof Error ? error.message : String(error);
  return {
    step: level,
    label: `Round ${level}`,
    summary: `Round ${level} failed: ${message}`,
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
    logger.info("starting deep-research-level");
    const { query, researchTopic, level, depthRemaining, breadth } = payload;
    const start = Date.now();

    // A level's own `current_step`, set the moment it STARTS. Previously only
    // `deep-researcher-full-run.ts` wrote this field, and only twice — `1`
    // before level 1, then `depth + 1` before the final report — so levels
    // 2..depth were NEVER named by it. `mergeRunSteps` in the web app decides
    // a not-yet-arrived row is "running" only when its number equals
    // `current_step`, which meant the intermediate levels could not render as
    // in-flight under any circumstance: they jumped straight from "Waiting…"
    // to done. Still best-effort, for the reason `deep-researcher-full-run.ts`
    // already documents (concurrent sibling branches mean one scalar cannot
    // precisely name "the" step in flight) — but monotonic in practice, since
    // a deeper level only ever starts after its own parent set the lower
    // value.
    metadata.root.set("current_step", level);

    // A caller-approved query list replaces this level's own planning step
    // outright — the human already did the query expansion, in conversation,
    // and re-planning here would throw their decisions away and reintroduce
    // exactly the run-to-run variance approving a plan is meant to remove.
    // Also saves this level's `plan-research` call, so the run costs strictly
    // less than the budget computed for it upstream.
    const approved = (payload.queries ?? []).map((q) => q.trim()).filter(Boolean);
    if (approved.length > 0) {
      logger.info("deep-research-level: using caller-approved queries; skipping plan-research", {
        level,
        queries: approved,
      });
      return await runLevel(payload, approved, { planUnderDelivered: false, start });
    }

    const plan = await mdragPlanResearch.triggerAndWait({ topic: query }).unwrap();
    // `subquestions` is optional in mdrag's schema (server-side default); a
    // missing list is the same "under-delivered" case handled just below.
    const subquestions = plan.subquestions ?? [];

    // `plan-research` is an LLM call and can legitimately come back with zero
    // subquestions, in which case this level silently collapses to a SINGLE
    // query (the raw seed) no matter what breadth was requested. That is the
    // largest single source of run-to-run variance in how much this workflow
    // actually searches — one run plans 5 subquestions, the next plans none
    // and searches once — and it used to leave no trace anywhere. Name both
    // the total collapse and the partial under-delivery.
    const planUnderDelivered = subquestions.length === 0;
    if (planUnderDelivered) {
      logger.warn(
        "deep-research-level: plan-research returned no subquestions; falling back to a single query on the raw seed, so this level searches 1 query instead of the requested breadth",
        { level, depthRemaining, requestedBreadth: breadth, seedQuery: query }
      );
    } else if (subquestions.length < breadth) {
      logger.warn("deep-research-level: plan-research returned fewer subquestions than the requested breadth", {
        level,
        requestedBreadth: breadth,
        nSubquestions: subquestions.length,
      });
    }

    const planned = (subquestions.length > 0 ? subquestions : [query]).slice(0, breadth);

    logger.info("deep-research-level: queries planned", { level, depthRemaining, breadth, queries: planned });

    return await runLevel(payload, planned, { planUnderDelivered, start });
  
    logger.info("completed deep-research-level");
  },
});

/**
 * Everything a level does once it knows WHICH queries it's running — search
 * them, record the step, recurse.
 *
 * Split out from the task body so the two ways a level can arrive at its
 * query list — `plan-research` deciding, or a human having approved them
 * beforehand — converge immediately afterwards and share one code path. The
 * alternative (branching inside the task and duplicating the fan-out) is how
 * the approved-queries path would quietly drift from the planned one.
 */
async function runLevel(
  payload: DeepResearchLevelPayload,
  queries: string[],
  { planUnderDelivered, start }: { planUnderDelivered: boolean; start: number }
): Promise<DeepResearchLevelResult> {
  const { researchTopic, level, depthRemaining, breadth } = payload;

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

  // Sources found vs sources kept, summed across this level's queries — the
  // numbers that explain why two runs of the same topic report wildly
  // different amounts of evidence. `deep-research-query.ts` returns them
  // per query precisely so they can surface HERE, on the step a viewer
  // actually reads, instead of only in Trigger.dev's logs. "3 sources" and
  // "15 searched, 3 kept" describe very different runs; showing only the
  // survivors makes a heavily-filtered run indistinguishable from a run
  // that barely searched.
  const hitsFound = queryResults.reduce((n, r) => n + r.hitsFound, 0);
  const hitsKept = queryResults.reduce((n, r) => n + r.hitsKept, 0);

  const step: PatternHunterStep = {
    step: level,
    label: `Round ${level}`,
    summary:
      `${queries.length} ${queries.length === 1 ? "query" : "queries"}` +
      (planUnderDelivered ? " (no research plan returned — searched the topic directly)" : "") +
      (nFailedQueries > 0 ? ` · ${nFailedQueries} failed` : "") +
      ` · ${hitsFound} sources searched, ${hitsKept} kept as relevant` +
      ` · ${ownLearnings.length} ${ownLearnings.length === 1 ? "learning" : "learnings"}`,
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

  // The caller asked to go deeper, but nothing here raised a follow-up
  // question to go deeper ON. Record that as an explicit, reasoned step for
  // the level that won't run — see `skippedLevelStep`'s own doc comment for
  // why an absence is not an acceptable way to communicate this.
  if (depthRemaining > 1 && recursable.length === 0) {
    logger.warn(
      "deep-research-level: depth remains but no query raised a follow-up question; not recursing",
      { level, depthRemaining, nQueries: queryResults.length }
    );
    const skipStep = skippedLevelStep(
      level + 1,
      `Not run — nothing in round ${level} raised a follow-up question worth researching.`
    );
    assertStepFitsMetadataBudget(skipStep);
    metadata.root.set("generated_at", new Date().toISOString()).append("steps", forMetadata(skipStep));
    allSteps = allSteps.concat([skipStep]);
  }

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
}
