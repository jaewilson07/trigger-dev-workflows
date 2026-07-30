import { task, metadata } from "@trigger.dev/sdk";
import { postPatternHunter } from "../lib/pattern-hunter-client.js";
import type { PatternHunterStep } from "../lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "../lib/pattern-hunter-types.js";

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
 * `metadata.parent.append` below — one source of truth, not two). */
export type ContextSnapshotResult = {
  status: string;
  business_input: string;
  snapshot: IndustrySnapshot;
  usage: Usage;
  step: PatternHunterStep;
};

export const patternHunterContextSnapshot = task({
  id: "pattern-hunter-context-snapshot",
  // Node 1 makes exactly one Letta call and no mdrag call — retry covers a
  // transient Letta 500/502 (unparseable structured output), same reasoning
  // as every other Pattern Hunter node task in this file group.
  retry: { maxAttempts: 2 },
  run: async (payload: PatternHunterContextSnapshotPayload): Promise<ContextSnapshotResult> => {
    const start = Date.now();
    const response = await postPatternHunter<Omit<ContextSnapshotResult, "step">>(
      "context-snapshot",
      { business_input: payload.business_input }
    );

    const step: PatternHunterStep = {
      step: 1,
      label: "Context Parser",
      summary: truncate(response.snapshot.summary),
      status: "done",
      items: [],
      duration_ms: Date.now() - start,
    };

    // datacrew#332: push this step into the PARENT run's live metadata as
    // soon as it's known — NOT `metadata.set`, which would write to THIS
    // task's own (child) run, invisible to a subscriber watching the
    // orchestrator's run (see `WorkflowRunResult`'s doc comment in
    // lib/pattern-hunter-types.ts, "Two known specifics" in the issue).
    assertStepFitsMetadataBudget(step);
    metadata.parent
      .set("generated_at", new Date().toISOString())
      .append("steps", forMetadata(step));

    return { ...response, step };
  },
});
