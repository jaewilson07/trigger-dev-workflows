import { task, metadata, logger } from "@trigger.dev/sdk";
import { postPatternHunter } from "../lib/pattern-hunter-client.js";
import type { Usage } from "./pattern-hunter-context-snapshot.js";
import type { EvidenceSource, PainPoint } from "./pattern-hunter-pain-points.js";
import type { PatternHunterStep } from "../lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "../lib/pattern-hunter-types.js";

/** Mirrors Pattern Hunter's `DoneForYouAssetType` literal union. */
export type DoneForYouAssetType =
  | "quoting filter"
  | "asset tracking spreadsheet"
  | "job briefing SOP"
  | "upsell script"
  | "intake form"
  | "other";

/** Mirrors Pattern Hunter's `DoneForYouAsset`. */
export type DoneForYouAsset = {
  asset_type: DoneForYouAssetType;
  description: string;
  content: string;
};

/** Mirrors Pattern Hunter's `HypothesisCard`. */
export type HypothesisCard = {
  title: string;
  hypothesis_statement: string;
  confirmation_questions: string[];
  done_for_you_asset: DoneForYouAsset;
};

export type PatternHunterHypothesesPayload = {
  business_input: string;
  pain_points: PainPoint[];
  /** Optional (Pattern Hunter datacrew#301) — same shape
   * `PainPointsResult.evidence_sources` returns. When non-empty, Pattern
   * Hunter grounds an mdrag `synthesize` call with these before generating
   * hypothesis cards; when absent/empty, no mdrag call happens there at all
   * (a legitimate mode, not an error). */
  evidence_sources?: EvidenceSource[];
};

/** Mirrors Pattern Hunter's `HypothesesResponse` (Node 3), PLUS `step`
 * (datacrew#332) — see `ContextSnapshotResult`'s doc comment in
 * `pattern-hunter-context-snapshot.ts`. */
export type HypothesesResult = {
  status: string;
  business_input: string;
  hypothesis_cards: HypothesisCard[];
  usage: Usage;
  step: PatternHunterStep;
};

export const patternHunterHypotheses = task({
  id: "pattern-hunter-hypotheses",
  // Node 3 optionally calls mdrag synthesize (degrades to a logged warning
  // on failure server-side, per main.py's own docstring) plus one Letta
  // call that can 502 on unparseable output — same maxAttempts as the other
  // LLM-calling nodes.
  retry: { maxAttempts: 2 },
  run: async (payload: PatternHunterHypothesesPayload): Promise<HypothesesResult> => {
    logger.info("starting pattern-hunter-hypotheses");
    const start = Date.now();
    const response = await postPatternHunter<Omit<HypothesesResult, "step">>("hypotheses", {
      business_input: payload.business_input,
      pain_points: payload.pain_points,
      evidence_sources: payload.evidence_sources ?? null,
    });

    // No `PatternResult` variant fits a hypothesis card without forcing it
    // (see pattern-hunter-full-run.ts's docstring) — items stays empty;
    // summary carries the useful one-liner instead, same as before #332.
    const step: PatternHunterStep = {
      step: 3,
      label: "Hypothesis Engine",
      summary: `${response.hypothesis_cards.length} hypothesis cards generated`,
      status: "done",
      items: [],
      duration_ms: Date.now() - start,
    };

    assertStepFitsMetadataBudget(step);
    metadata.root
      .set("generated_at", new Date().toISOString())
      .append("steps", forMetadata(step));

    return { ...response, step };
  
    logger.info("completed pattern-hunter-hypotheses");
  },
});
