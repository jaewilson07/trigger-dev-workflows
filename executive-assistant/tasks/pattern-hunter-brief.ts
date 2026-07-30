import { task, metadata } from "@trigger.dev/sdk";
import { postPatternHunter } from "../lib/pattern-hunter-client.js";
import type { IndustrySnapshot } from "./pattern-hunter-context-snapshot.js";
import type { EvidenceSource, PainPoint } from "./pattern-hunter-pain-points.js";
import type { HypothesisCard } from "./pattern-hunter-hypotheses.js";
import type { HypothesisRedTeamResult } from "./pattern-hunter-red-team.js";
import type { PatternHunterStep, RecommendationResult } from "../lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "../lib/pattern-hunter-types.js";

export type PatternHunterBriefPayload = {
  business_input: string;
  industry_snapshot?: IndustrySnapshot;
  evidence_sources: EvidenceSource[];
  pain_points: PainPoint[];
  hypothesis_cards: HypothesisCard[];
  red_team_results: HypothesisRedTeamResult[];
};

/** Mirrors Pattern Hunter's `RecommendationResult` (`main.py`) — the ONE
 * `PatternResult` variant `/brief` extracts this slice (datacrew#301 scoped
 * to `recommendation` only; see that endpoint's docstring). NOTE: Pattern
 * Hunter's own Python model omits the frontend's optional `cta_label`/
 * `cta_url` fields entirely (never populated) — this type reflects exactly
 * what the wire response contains, not the fuller frontend shape (see
 * `lib/pattern-hunter-types.ts`'s `RecommendationResult` for that; the
 * orchestrator maps between the two).
 */
export type BriefRecommendation = {
  type: "recommendation";
  relevance: string;
  action: string;
  derived_from: string[];
  tags: string[] | null;
};

/** Mirrors Pattern Hunter's `BriefResponse` (final packaging, datacrew#301).
 * `answer_found`/`complete_answer_found`/`missing_required_fields` mirror
 * mdrag's `extract-results` contract verbatim — a well-formed refusal is a
 * 200 here, not a thrown error (see `main.py`'s `/brief` docstring).
 *
 * PLUS `step` (datacrew#332) — see `ContextSnapshotResult`'s doc comment in
 * `pattern-hunter-context-snapshot.ts`. `synthesis_narrative` was already
 * typed here before #332, but nothing ever read it: the orchestrator built
 * its own step object and never referenced this field, so the narrative
 * `/brief` computed was silently discarded on every run. #332 fixes that —
 * see `step.narrative` below.
 */
export type BriefResult = {
  status: string;
  business_input: string;
  recommendations: BriefRecommendation[];
  answer_found: boolean;
  complete_answer_found: boolean;
  missing_required_fields: string[];
  synthesis_narrative: string;
  step: PatternHunterStep;
};

/** Maps `POST /brief`'s already-grounded `recommendations` 1:1 onto
 * `RecommendationResult`, adding the `type` discriminant Pattern Hunter's
 * Python response doesn't include. `derived_from` and `relevance`/`action`
 * come straight from Pattern Hunter, which already grounds them via mdrag's
 * extract-results verbatim-quote validation (see `main.py`'s `/brief`
 * docstring / `_evidence_appendix`) — no re-deriving needed here. Moved here
 * from `pattern-hunter-full-run.ts` (datacrew#332), same reasoning as
 * `buildEvidenceItems`'s move in `pattern-hunter-pain-points.ts`. */
function buildRecommendationItems(recommendations: BriefRecommendation[]): RecommendationResult[] {
  return recommendations.map((rec) => ({
    type: "recommendation",
    relevance: rec.relevance,
    action: rec.action,
    derived_from: rec.derived_from,
    ...(rec.tags && rec.tags.length > 0 ? { tags: rec.tags } : {}),
  }));
}

export const patternHunterBrief = task({
  id: "pattern-hunter-brief",
  // Final packaging makes TWO mdrag calls (synthesize, then extract-results)
  // that both fail loud (502) on this endpoint per main.py's own docstring
  // ("no reasonable degrade-and-continue for either call in /brief") — the
  // most retry-worthy of the five nodes, but still just maxAttempts: 2 to
  // match the rest rather than masking a persistently broken mdrag call
  // behind a long retry tail.
  retry: { maxAttempts: 2 },
  run: async (payload: PatternHunterBriefPayload): Promise<BriefResult> => {
    const start = Date.now();
    const response = await postPatternHunter<Omit<BriefResult, "step">>("brief", {
      business_input: payload.business_input,
      industry_snapshot: payload.industry_snapshot ?? null,
      evidence_sources: payload.evidence_sources,
      pain_points: payload.pain_points,
      hypothesis_cards: payload.hypothesis_cards,
      red_team_results: payload.red_team_results,
    });

    // Honest summary: don't let a refuse-route brief (answer_found: false)
    // silently look identical to a successful one — see
    // pattern-hunter-full-run.ts's docstring and the resolved design
    // (unchanged from before #332, just relocated to where the data is).
    const summary = response.answer_found
      ? `${response.recommendations.length} grounded recommendation${response.recommendations.length === 1 ? "" : "s"}`
      : `No recommendations could be grounded${
          response.missing_required_fields.length
            ? ` (missing: ${response.missing_required_fields.join(", ")})`
            : ""
        }`;

    const step: PatternHunterStep = {
      step: 5,
      label: "Final Packaging",
      summary,
      status: "done",
      items: buildRecommendationItems(response.recommendations),
      duration_ms: Date.now() - start,
      // datacrew#332: carry /brief's synthesis_narrative into the step
      // instead of discarding it — omitted entirely (not an empty string)
      // when Pattern Hunter didn't produce one, matching this codebase's
      // "omit rather than guess/pad" convention for optional fields
      // (mirrors deriveEvidenceTags' undefined-when-nothing-matches choice
      // in pattern-hunter-pain-points.ts).
      ...(response.synthesis_narrative ? { narrative: response.synthesis_narrative } : {}),
    };

    assertStepFitsMetadataBudget(step);
    metadata.parent
      .set("generated_at", new Date().toISOString())
      .append("steps", forMetadata(step));

    return { ...response, step };
  },
});
