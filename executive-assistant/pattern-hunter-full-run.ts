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
import type { Persona, PatternHunterReport, PatternHunterStep, WorkflowRunResult } from "./lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "./lib/pattern-hunter-types.js";

/**
 * datacrew#302 — the final tracer-bullet slice: a full Trigger.dev workflow
 * orchestrating Pattern Hunter's real HTTP service
 * (`projects/pattern-hunter/main.py`) end to end — Context Parser ->
 * Pattern Scraper -> Hypothesis Engine -> Red Team -> Final Packaging — with
 * each step as its own `task()` (mirroring `research-primitives-demo.ts`'s
 * #298 structure) for real per-step observability/retries in Trigger.dev's
 * dashboard, and mapping the result onto mdrag's `PatternHunterReport` shape
 * (`~/GitHub/mdrag/frontend/types/pattern-hunter.ts`, mirrored locally in
 * `lib/pattern-hunter-types.ts`) so `wiki.datacrew.space/pattern-hunter`
 * (mdrag#836/#892) can eventually consume a real run as a drop-in
 * replacement for its current mocked fixture.
 *
 * This is a NEW sibling workflow, same as `research-primitives-demo.ts` —
 * `morning-brief.ts` and every pre-existing file under `tasks/` are
 * untouched.
 *
 * ## Mapping design — why only steps 2 and 5 get real `items`
 *
 * Per the resolved design (see this PR's description), Pattern Hunter's 5
 * endpoints do NOT map 1:1 onto mdrag's 5 `PatternResult` variants:
 *
 * - **Step 1 (Context Parser)** produces an `IndustrySnapshot` — a flat
 *   record of narrative fields, not a list of discrete findings. It doesn't
 *   cleanly fit `evidence` (nothing was "found on the internet" here — it's
 *   the Letta agent's own synthesis) or any other variant. `items: []`;
 *   the snapshot's own `summary` carries the useful one-liner instead.
 * - **Step 2 (Pattern Scraper)** genuinely IS a list of things found on the
 *   internet — `evidence_sources` maps naturally onto `EvidenceResult` (see
 *   `buildEvidenceItems` in `tasks/pattern-hunter-pain-points.ts`).
 * - **Step 3 (Hypothesis Engine)** produces hypothesis cards (statement +
 *   confirmation questions + a done-for-you asset) — no existing
 *   `PatternResult` variant fits that shape without forcing it (it's not a
 *   gap, not a single recommendation, not a metric). `items: []`; `summary`
 *   carries a one-liner count instead.
 * - **Step 4 (Red Team)** produces pass/fail verdicts, not new findings to
 *   list. `items: []`; `summary` reports the pass rate.
 * - **Step 5 (Final Packaging)** — Pattern Hunter's own `POST /brief`
 *   already returns `recommendation`-shaped `PatternResult` items, grounded
 *   server-side with real `derived_from` evidence-id citations. Maps 1:1
 *   onto `RecommendationResult` (see `buildRecommendationItems` in
 *   `tasks/pattern-hunter-brief.ts`).
 *
 * This is intentional, not a shortcut: forcing pain points/hypotheses/
 * red-team results into ill-fitting `PatternResult` variants would be
 * exactly the "forcing a bad abstraction" this whole primitives effort has
 * consistently avoided — see mdrag ADR-0026's precedent ("if it can't
 * cleanly cover both, say so and scope down rather than force it").
 *
 * ## Run envelope + live progress metadata (datacrew#332)
 *
 * Two additions on top of #302's shape:
 *
 * 1. **Run envelope.** `WorkflowRunResult` (`lib/pattern-hunter-types.ts`) is
 *    a NEW, shared, workflow-agnostic type — "wraps the existing step list
 *    with the run-level facts a viewer needs (which workflow, the input,
 *    overall status, generated-at)," per the issue's own wording — used as
 *    THIS task's live run-metadata shape. It is deliberately NOT defined in
 *    this file: issue #336 (Deep Researcher) is blocked on #332 specifically
 *    to reuse this exact shape with a different `workflow` name and a
 *    different `input`, so it lives in `lib/` where any future workflow's
 *    tasks/orchestrator can import it too. See that type's own doc comment
 *    for the full naming rationale (kept the local `<Thing>Result`
 *    convention, no `*Envelope` type name).
 *
 *    Separately, this task's own RETURN value (`PatternHunterFullRunResult`
 *    below) ALSO carries run identity (`run_id`/`started_at`/`duration_ms`)
 *    alongside the mdrag-mirrored `PatternHunterReport`. This is a genuinely
 *    different concept from the live envelope above, not a duplicate of it:
 *    `report` must stay pinned to mdrag's exact wire contract (`subject`/
 *    `industry`/`persona`, no `workflow`/`input`) so
 *    `wiki.datacrew.space/pattern-hunter` keeps working, which
 *    `WorkflowRunResult` deliberately does NOT preserve (it's generic across
 *    workflows, not mdrag's specific shape) — so the two co-exist rather
 *    than one subsuming the other.
 *
 * 2. **Live progress metadata, emitted by the CHILD tasks, not centralized
 *    here.** Per the issue: "each of the five Pattern Hunter node tasks
 *    pushes its completed step into the envelope as it finishes." Each task
 *    in `tasks/pattern-hunter-*.ts` now builds its OWN `PatternHunterStep`
 *    (reusing exactly the same construction logic it needs to build the
 *    `step` field on its own return value — one source of truth, not two)
 *    and appends it to the run metadata via `metadata.parent.append(...)`
 *    — NOT `metadata.set`, which would write to that CHILD's own run,
 *    invisible to anyone subscribed to THIS orchestrator's run (the issue's
 *    own "two known specifics" callout). This orchestrator's job is now
 *    narrower: seed the envelope before step 1 (`workflow`/`input`/
 *    `status: "running"`/`generated_at`/`steps: []`), mark which step is
 *    about to start (`publishStepStarted`, so a subscriber sees "step N
 *    running" the moment it begins, not only once the child appends its
 *    finished entry), read `step` back off each successful child's own
 *    result to build `report.steps`, and — ONLY on a failure, since a
 *    failing child never gets to construct+append its own step — build and
 *    append the failed step itself (`publishStepFailed`). Flips `status` to
 *    `"completed"`/`"failed"` at the very end either way.
 *
 * 3. **`items` stay IN the live metadata**, not stripped. An earlier version
 *    of this PR stripped `items` from the metadata `steps` array to stay
 *    comfortably under Trigger.dev's 256KB run-metadata cap — legitimate
 *    concern, but it directly conflicts with the issue's own AC ("each step
 *    appears... with its real label, summary, status, item list, and
 *    duration") and defeats the point for a step-reveal UI, which needs the
 *    findings AS they arrive, not just a label followed by a bulk dump at
 *    the end. Resolved by MEASURING a realistic payload instead of guessing
 *    — see `MAX_STEP_METADATA_BYTES`'s doc comment in
 *    `lib/pattern-hunter-types.ts` for the numbers — and enforcing an
 *    explicit, loud per-step size budget (`assertStepFitsMetadataBudget`)
 *    rather than silently truncating if a step ever did exceed it.
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
 * gap) — this is the clearly-labeled placeholder used when the caller
 * doesn't supply one.
 */
const PLACEHOLDER_PERSONA: Persona = {
  role: "Operator",
  concerns: [],
  focus_areas: [],
  reference_urls: [],
};

export type PatternHunterFullRunPayload = {
  business_input: string;
  /** Overrides the report's `industry` field. Defaults to `business_input`
   * when absent — best effort, since Pattern Hunter's backend has no
   * separate "industry" concept distinct from the business input itself. */
  industry?: string;
  /** Optional caller-supplied persona (see `PLACEHOLDER_PERSONA` above for
   * the fallback and `lib/pattern-hunter-types.ts`'s `Persona` doc comment
   * for the known gap this works around). */
  persona?: Persona;
};

export type PatternHunterFullRunResult = {
  /**
   * Trigger.dev's own run id (`ctx.run.id`) — lets a caller correlate this
   * returned report with the specific Trigger.dev run that produced it,
   * e.g. to mint a scoped `auth.createPublicToken` for a frontend that
   * already subscribed to this run's live progress metadata (see
   * `WorkflowRunResult` in `lib/pattern-hunter-types.ts`) before this final
   * result existed.
   */
  run_id: string;
  /**
   * Overall run status, inspectable independent of any individual step's
   * own `status`/`error` — set to `"failed"` the moment any step fails
   * (see the per-step try/catch blocks below), `"completed"` only when all
   * 5 steps finished. `report.steps` always reflects exactly what
   * completed before that point (never thrown away on a mid-chain
   * failure) — see this module's docstring / this PR's description for the
   * full failure-visibility design.
   *
   * NOTE: this is a strictly NARROWER set than the live envelope's own
   * `WorkflowRunStatus`, which additionally has `"pending"`/`"running"` —
   * this type is the RETURN value, only ever read after the run finishes
   * one way or the other, so those can never be values here by construction.
   */
  status: "completed" | "failed";
  /** ISO timestamp this run started (`ctx.run.startedAt`) — distinct from
   * `report.generated_at` (when the report object was assembled, a few ms
   * before return) and each step's own `duration_ms` (per-step wall time
   * only, now measured task-side — see each task's own `step` construction
   * — so it excludes the `triggerAndWait` queue/dispatch overhead this
   * orchestrator's own wall-clock timers used to include pre-#332). */
  started_at: string;
  /** Total wall-clock duration of the whole run, start to return, in ms. */
  duration_ms: number;
  report: PatternHunterReport;
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

function buildReport(
  subject: string,
  industry: string,
  persona: Persona,
  steps: PatternHunterStep[]
): PatternHunterReport {
  return {
    subject,
    industry,
    persona,
    generated_at: new Date().toISOString(),
    steps,
  };
}

/** Assembles the run's own return-value envelope around `buildReport`'s
 * `PatternHunterReport` — the single place `run_id`/`started_at`/
 * `duration_ms` get computed, called from every return point in `run()`
 * (five failure branches plus the final success return) so none of them can
 * drift out of sync with each other. Distinct from the LIVE
 * `WorkflowRunResult` metadata envelope — see this module's docstring,
 * "Run envelope" section, for why both exist. */
function buildRunResult(
  status: "completed" | "failed",
  runId: string,
  runStartedAt: Date,
  businessInput: string,
  industry: string,
  persona: Persona,
  steps: PatternHunterStep[]
): PatternHunterFullRunResult {
  return {
    run_id: runId,
    status,
    started_at: runStartedAt.toISOString(),
    duration_ms: Date.now() - runStartedAt.getTime(),
    report: buildReport(businessInput, industry, persona, steps),
  };
}

/** Marks step `stepNumber` as the one now in flight, BEFORE its
 * `triggerAndWait` call — so a live subscriber sees "step 3/5 running"
 * immediately, not only once step 3's own task appends its finished entry
 * (see this module's docstring, "live progress metadata" section). Writes
 * to THIS run's own metadata (`metadata.set`, not `.parent`) — the
 * orchestrator IS the run a subscriber watches. */
function publishStepStarted(stepNumber: number): void {
  metadata.set("current_step", stepNumber);
}

/** Records a step that failed BEFORE it could construct+append its own
 * entry (a child that failed never reaches the point in its own `run()`
 * where it builds a `PatternHunterStep` — see each task file's own
 * try-less, let-it-throw design). Only the orchestrator can observe "this
 * child is genuinely, finally failed" (after its own `retry.maxAttempts` is
 * exhausted and `triggerAndWait().unwrap()` throws), so only the
 * orchestrator publishes the failure — successful steps are published by
 * the child that produced them. */
function publishStepFailed(step: PatternHunterStep): void {
  assertStepFitsMetadataBudget(step);
  metadata
    .set("status", "failed")
    .set("generated_at", new Date().toISOString())
    .append("steps", forMetadata(step));
}

/**
 * Trigger this from the trigger.dev dashboard's "Test" tab on
 * `pattern-hunter-full-run`, payload `{"business_input": "trailer rental
 * company"}` — five child-task runs (`pattern-hunter-context-snapshot`,
 * `-pain-points`, `-hypotheses`, `-red-team`, `-brief`), each with its own
 * per-step timing/logs/retries in Trigger.dev's dashboard, satisfying
 * datacrew#302's "each step visible individually in Trigger.dev's run
 * history" acceptance criterion.
 *
 * Subscribe to THIS run's live progress (datacrew#332) from a frontend or
 * backend via `useRealtimeRun`/`runs.subscribeToRun`, reading
 * `run.metadata` — see `WorkflowRunResult` in `lib/pattern-hunter-types.ts`
 * for the exact shape and this module's docstring for when each field
 * updates. The final resolved value additionally carries a run envelope
 * (`run_id`/`started_at`/`duration_ms`) around the `PatternHunterReport` —
 * see `PatternHunterFullRunResult` above.
 *
 * STRUCTURAL VERIFICATION ONLY as of this PR (same situation #298/#302 were
 * in): Pattern Hunter's FastAPI service is deployed on bonker
 * (`projects/pattern-hunter/AGENTS.md`'s "Deployment" section), but this
 * Trigger.dev task itself has never been pushed to a live Trigger.dev
 * instance (that AGENTS.md's own "Still open" note), and this sandbox has
 * neither a `LETTA_API_KEY` nor network access to bonker. A genuine
 * end-to-end run — trigger this task for real and watch `run.metadata`
 * update live — was NOT performed and could not have been from here; see
 * this PR's description for exactly what was and wasn't exercised, and for
 * the measured (not guessed) metadata-size numbers behind
 * `MAX_STEP_METADATA_BYTES`.
 */
export const patternHunterFullRun = task({
  id: "pattern-hunter-full-run",
  // The orchestrator itself does NOT retry as a whole (maxAttempts: 1,
  // matching research-primitives-demo.ts's own top-level task) — each
  // sub-task already retries independently (maxAttempts: 2 apiece).
  // Re-running the WHOLE chain on an orchestrator-level retry would re-fire
  // already-succeeded steps' side effects (mdrag search-providers calls,
  // Letta messages billed per call) for no benefit; a failure that survives
  // its own sub-task's retries is surfaced via this task's `status: "failed"`
  // return value instead (see the failure-visibility design in this
  // module's docstring), not by throwing and losing prior step results.
  retry: { maxAttempts: 1 },
  run: async (
    payload: PatternHunterFullRunPayload,
    { ctx }
  ): Promise<PatternHunterFullRunResult> => {
    const businessInput = payload.business_input?.trim();
    if (!businessInput) {
      throw new Error("business_input is required");
    }
    const industry = payload.industry?.trim() || businessInput;
    const persona = payload.persona ?? PLACEHOLDER_PERSONA;

    const runStartedAt = ctx.run.startedAt;

    // Seed the live run envelope (datacrew#332) BEFORE step 1 starts, via
    // `.replace()` rather than a chain of `.set()` calls — this is the one
    // place the metadata shape is checked against `WorkflowRunResult` by the
    // compiler (`satisfies`), so a future field rename here would be caught
    // at typecheck time even though the per-field `.set()`/`.append()` calls
    // (here and in each task file) stay loosely typed (matching the SDK's
    // own "currently loosely typed" metadata API, per `runs/metadata.mdx`).
    metadata.replace(
      forMetadata({
        workflow: "pattern-hunter",
        input: payload,
        status: "running",
        generated_at: runStartedAt.toISOString(),
        steps: [],
      } satisfies WorkflowRunResult<PatternHunterFullRunPayload>)
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
      return buildRunResult("failed", ctx.run.id, runStartedAt, businessInput, industry, persona, steps);
    }
    // The task already built + published its own step (metadata.parent.append)
    // — just read it back, no re-derivation.
    steps.push(contextSnapshot.step);
    logger.info("context-snapshot complete", { businessInput });

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
      return buildRunResult("failed", ctx.run.id, runStartedAt, businessInput, industry, persona, steps);
    }
    steps.push(painPoints.step);
    logger.info("pain-points complete", {
      businessInput,
      nPainPoints: painPoints.pain_points.length,
      nEvidenceSources: painPoints.evidence_sources.length,
    });

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
      return buildRunResult("failed", ctx.run.id, runStartedAt, businessInput, industry, persona, steps);
    }
    steps.push(hypotheses.step);
    logger.info("hypotheses complete", {
      businessInput,
      nCards: hypotheses.hypothesis_cards.length,
    });

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
      return buildRunResult("failed", ctx.run.id, runStartedAt, businessInput, industry, persona, steps);
    }
    const nPassed = redTeam.results.filter((r) => r.overall_pass).length;
    steps.push(redTeam.step);
    logger.info("red-team complete", { businessInput, nPassed, nTotal: redTeam.results.length });

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
      return buildRunResult("failed", ctx.run.id, runStartedAt, businessInput, industry, persona, steps);
    }
    steps.push(brief.step);
    logger.info("brief complete", {
      businessInput,
      answerFound: brief.answer_found,
      completeAnswerFound: brief.complete_answer_found,
      nRecommendations: brief.recommendations.length,
    });

    // All 5 steps finished — flip the live envelope's status to "completed"
    // (it was "running" the whole way through; only `publishStepFailed`
    // ever flips it to "failed") to match this task's own terminal return
    // value below.
    metadata.set("status", "completed").set("generated_at", new Date().toISOString());

    return buildRunResult("completed", ctx.run.id, runStartedAt, businessInput, industry, persona, steps);
  },
});
