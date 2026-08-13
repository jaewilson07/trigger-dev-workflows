import { task, metadata, logger } from "@trigger.dev/sdk";
import { postPatternHunter } from "../lib/pattern-hunter-client.js";
import type { Usage } from "./pattern-hunter-context-snapshot.js";
import type { HypothesisCard } from "./pattern-hunter-hypotheses.js";
import type { PatternHunterStep } from "../lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "../lib/pattern-hunter-types.js";

/** Mirrors Pattern Hunter's `RedTeamCriterionName` literal union. */
export type RedTeamCriterionName =
  | "actionable_within_48h"
  | "low_cost"
  | "addresses_fear"
  | "has_opening_line";

/** Mirrors Pattern Hunter's `CriterionResult`. */
export type CriterionResult = {
  criterion: RedTeamCriterionName;
  passed: boolean;
  rationale: string;
};

/** Mirrors Pattern Hunter's `HypothesisRedTeamResult`. `overall_pass` is
 * computed deterministically server-side (AND-of-4), never the LLM's own
 * self-aggregation — see `main.py`'s `_apply_red_team_criteria`. */
export type HypothesisRedTeamResult = {
  hypothesis_title: string;
  overall_pass: boolean;
  criteria: CriterionResult[];
  opening_line: string;
  replacement_recommendation: string | null;
};

export type PatternHunterRedTeamPayload = {
  business_input: string;
  hypothesis_cards: HypothesisCard[];
};

/** Mirrors Pattern Hunter's `RedTeamResponse` (Node 4), PLUS `step`
 * (datacrew#332) — see `ContextSnapshotResult`'s doc comment in
 * `pattern-hunter-context-snapshot.ts`. */
export type RedTeamResult = {
  status: string;
  business_input: string;
  results: HypothesisRedTeamResult[];
  usage: Usage;
  step: PatternHunterStep;
};

export const patternHunterRedTeam = task({
  id: "pattern-hunter-red-team",
  // Node 4 is bespoke (zero mdrag calls, per main.py's module docstring) but
  // still makes one Letta call that can 502 on an unparseable/incomplete
  // criteria set or a failed hypothesis missing a replacement_recommendation
  // — same maxAttempts as the other LLM-calling nodes.
  retry: { maxAttempts: 2 },
  run: async (payload: PatternHunterRedTeamPayload): Promise<RedTeamResult> => {
    logger.info("starting pattern-hunter-red-team");
    const start = Date.now();
    const response = await postPatternHunter<Omit<RedTeamResult, "step">>("red-team", {
      business_input: payload.business_input,
      hypothesis_cards: payload.hypothesis_cards,
    });

    // Pass/fail verdicts, not new findings to list — items stays empty,
    // same as before #332 (see pattern-hunter-full-run.ts's docstring).
    const nPassed = response.results.filter((r) => r.overall_pass).length;
    const step: PatternHunterStep = {
      step: 4,
      label: "Red Team",
      summary: `${nPassed}/${response.results.length} hypotheses passed red-team review`,
      status: "done",
      items: [],
      duration_ms: Date.now() - start,
    };

    assertStepFitsMetadataBudget(step);
    metadata.root
      .set("generated_at", new Date().toISOString())
      .append("steps", forMetadata(step));

    logger.info("completed pattern-hunter-red-team");

    return { ...response, step };
  },
});
