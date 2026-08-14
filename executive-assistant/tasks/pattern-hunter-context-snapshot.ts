import { postPatternHunter } from "../lib/pattern-hunter-client.js";
import type { PatternHunterStep } from "../lib/pattern-hunter-types.js";
import { createPatternHunterStepTask } from "../lib/pattern-hunter-types.js";

export type PatternHunterContextSnapshotPayload = {
  business_input: string;
};

/** Truncates a long snapshot summary to a one-line-ish `PatternHunterStep`
 * `summary` (see that field's own doc comment: "One line shown while the
 * step is collapsed or still running"). Local to this file, not shared —
 * a small, single-use formatting helper, not a run-envelope concern. */
function truncate(text: string, maxLen = 220): string {
  const trimmed = text.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1).trimEnd()}…` : trimmed;
}

/** Mirrors Pattern Hunter's `IndustrySnapshot`
 * (`projects/pattern-hunter/main.py`), read directly from source rather than
 * guessed from the issue text. */
export type IndustrySnapshot = {
  asset_class: string;
  cash_flow_model: string;
  fragmentation: string;
  regulatory_friction: string;
  team_size_org: string;
  summary: string;
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
};

/** Mirrors Pattern Hunter's `ContextParserResponse` (Node 1), PLUS `step`
 * (datacrew#332) — this task's own `PatternHunterStep` projection of its
 * result, computed once here and handed back to the orchestrator so it
 * never has to re-derive step-construction logic that already lives here
 * (the same construction this task also pushes into the run envelope via
 * `createPatternHunterStepTask` below — one source of truth, not two). */
export type ContextSnapshotResult = {
  status: string;
  business_input: string;
  snapshot: IndustrySnapshot;
  usage: Usage;
  step: PatternHunterStep;
};

/**
 * Migrated onto `createPatternHunterStepTask` (datacrew#84) — the tracer
 * bullet for the factory built in `lib/pattern-hunter-types.ts`. Node 1
 * makes exactly one Letta call and no mdrag call — retry covers a transient
 * Letta 500/502 (unparseable structured output), same reasoning as every
 * other Pattern Hunter node task, which is why this task doesn't override
 * the factory's `PATTERN_HUNTER_STEP_RETRY_DEFAULT`.
 *
 * This `run` function is now ONLY the backend call and step-shaping specific
 * to Context Parser — no change to either from before the migration. The
 * task-definition boilerplate (`task({...})`), timing, `PatternHunterStep`
 * construction, `publishStep`, and start/complete logging all moved into the
 * factory.
 */
export const patternHunterContextSnapshot = createPatternHunterStepTask<
  PatternHunterContextSnapshotPayload,
  Omit<ContextSnapshotResult, "step">
>({
  id: "pattern-hunter-context-snapshot",
  step: 1,
  label: "Context Parser",
  run: async (payload) => {
    const response = await postPatternHunter<Omit<ContextSnapshotResult, "step">>(
      "context-snapshot",
      { business_input: payload.business_input }
    );

    return {
      response,
      summary: truncate(response.snapshot.summary),
    };
  },
});
