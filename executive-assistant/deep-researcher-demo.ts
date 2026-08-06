import { task, logger, metadata, wait } from "@trigger.dev/sdk";
import type { PatternHunterStep, WorkflowRunResult } from "./lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "./lib/pattern-hunter-types.js";

/**
 * datacrew#335 — a deliberately tiny SECOND workflow, originally existing for
 * exactly one reason: to prove the frontend's workflow registry
 * (`frontend/src/lib/workflow-registry.ts`) and its
 * `WorkflowRunResult`/`PatternHunterStep` renderers
 * (`frontend/src/components/step-reveal/`) are genuinely workflow-agnostic —
 * issue #335's own AC: "Adding a workflow requires only a registry entry and
 * a payload mapper... with no workflow-specific branching in the renderers."
 *
 * STATUS as of datacrew#339: the real Deep Researcher (`deep-researcher-full-
 * run.ts`, datacrew#336/#347) is now built and is what the frontend registry
 * points at — this task is NO LONGER registered in
 * `frontend/src/lib/workflow-registry.ts` (deliberate #339 decision, not an
 * oversight: keeping both entries would mean two workflows silently doing the
 * same "prove the registry" job, and the issue's own framing — "a second
 * workflow" — means exactly two entries, not three). This task is KEPT,
 * unregistered from the app, as a standing zero-dependency smoke test: it
 * calls NO external service (no LLM, no mdrag, no Letta), so it can still be
 * triggered and watched end-to-end with plain `trigger dev` and zero API
 * keys/credentials — useful for checking the trigger.dev live-metadata
 * mechanism itself is healthy independent of mdrag or Letta being up, which
 * `deep-researcher-full-run.ts` (mdrag-dependent) and
 * `pattern-hunter-full-run.ts` (Letta-dependent, currently failing on Letta
 * Cloud's 402) both cannot do right now. Trigger it directly from the
 * trigger.dev dashboard's "Test" tab or the CLI, not from the app.
 *
 * Why THIS shape specifically: `pattern-hunter-types.ts`'s `PatternHunterStep.
 * narrative` doc comment already earmarks it for "the future Deep Researcher
 * workflow (#336, whose steps are prose-first rather than item-list-first)."
 * Every step below sets `narrative` and leaves `items: []` — the one
 * combination Pattern Hunter's own 5 steps never produce (its `items`-bearing
 * steps are 2 and 5; steps 1/3/4 have neither items nor narrative). Exercising
 * that combination for real is what actually tested "no renderer branching"
 * at #335 time: if the step-reveal UI needed a Pattern-Hunter-specific `if` to
 * handle it, this task would have surfaced that at review time, not just in a
 * docstring. The real Deep Researcher now exercises the SAME combination for
 * real (its own per-level steps carry `items` + `narrative` together; its
 * final-report step carries `narrative` only) — see
 * `deep-researcher-full-run.ts`'s own docstring.
 */

const STEP_LABELS = ["Frame the question", "Draft findings", "Synthesize report"] as const;

export type DeepResearcherDemoPayload = {
  /** What to "research." Free text, >= 1 char after trim. */
  prompt: string;
};

export type DeepResearcherDemoResult = {
  run_id: string;
  status: "completed" | "failed";
  started_at: string;
  duration_ms: number;
  steps: PatternHunterStep[];
};

function narrativeForStep(stepNumber: number, prompt: string): string {
  switch (stepNumber) {
    case 1:
      return (
        `Framing the question before looking anything up: "${prompt}" breaks down into ` +
        `who's asking, what decision it's meant to inform, and what "done" looks like. ` +
        `This demo skips real retrieval and reasons about the prompt text alone.`
      );
    case 2:
      return (
        `If this were wired to real sources, this step would pull evidence for "${prompt}" ` +
        `and note where sources agree or conflict. In this offline demo, the only ` +
        `"finding" is the prompt itself, restated as a claim worth checking: ` +
        `"${prompt}" is true, false, or more nuanced than either — a real run would say which.`
      );
    default:
      return (
        `Synthesis: without real research behind it, this demo can't tell you the answer to ` +
        `"${prompt}" — only that the pipeline that WOULD answer it ran end to end, three ` +
        `steps, each one's narrative appended to this run's live metadata as it finished.`
      );
  }
}

/**
 * Trigger from the trigger.dev dashboard's "Test" tab on `deep-researcher-demo`,
 * payload `{"prompt": "will self-hosted trigger.dev scale past 50 workflows"}`,
 * or the CLI — NOT from the frontend as of datacrew#339 (see this module's
 * docstring: unregistered from `workflow-registry.ts` on purpose). Subscribe
 * to this run's live progress the same way as `pattern-hunter-full-run` —
 * read `run.metadata`, shaped as `WorkflowRunResult<DeepResearcherDemoPayload>`
 * (see `lib/pattern-hunter-types.ts`).
 *
 * Unlike `pattern-hunter-full-run.ts`, this task has no child tasks: three
 * steps, no sub-agent calls worth isolating for their own retries/
 * observability, so it publishes its own metadata directly via `metadata.set`/
 * `.append` (not `.parent.append` — there is no parent here, THIS run is the
 * one a subscriber watches).
 */
export const deepResearcherDemo = task({
  id: "deep-researcher-demo",
  retry: { maxAttempts: 1 },
  run: async (
    payload: DeepResearcherDemoPayload,
    {
    logger.info("starting deep-researcher-demo"); ctx 
    logger.info("completed deep-researcher-demo");
  }
  ): Promise<DeepResearcherDemoResult> => {
    const prompt = payload.prompt?.trim();
    if (!prompt) {
      throw new Error("prompt is required");
    }

    const runStartedAt = ctx.run.startedAt;

    metadata.replace(
      forMetadata({
        workflow: "deep-researcher-demo",
        input: payload,
        status: "running",
        generated_at: runStartedAt.toISOString(),
        steps: [],
      } satisfies WorkflowRunResult<DeepResearcherDemoPayload>)
    );

    const steps: PatternHunterStep[] = [];

    for (let stepNumber = 1; stepNumber <= STEP_LABELS.length; stepNumber++) {
      const stepStart = Date.now();
      metadata.set("current_step", stepNumber);

      // Simulated work — long enough for a subscriber to visibly observe
      // "running" before the step's own metadata append flips it to "done",
      // same UX property a real multi-second Letta/LLM call would have.
      await wait.for({ seconds: 1 });

      const narrative = narrativeForStep(stepNumber, prompt);
      const step: PatternHunterStep = {
        step: stepNumber,
        label: STEP_LABELS[stepNumber - 1] ?? `Step ${stepNumber}`,
        summary: narrative.slice(0, 140),
        status: "done",
        items: [],
        duration_ms: Date.now() - stepStart,
        narrative,
      };

      assertStepFitsMetadataBudget(step);
      metadata.set("generated_at", new Date().toISOString()).append("steps", forMetadata(step));
      steps.push(step);

      logger.info("deep-researcher-demo step complete", { stepNumber, prompt });
    }

    metadata.set("status", "completed").set("generated_at", new Date().toISOString());

    return {
      run_id: ctx.run.id,
      status: "completed",
      started_at: runStartedAt.toISOString(),
      duration_ms: Date.now() - runStartedAt.getTime(),
      steps,
    };
  },
});
