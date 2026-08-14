import { postPatternHunter } from "../lib/pattern-hunter-client.js";
import type { Usage } from "./pattern-hunter-context-snapshot.js";
import type { HypothesisCard } from "./pattern-hunter-hypotheses.js";
import type { PatternHunterStep } from "../lib/pattern-hunter-types.js";
import { createPatternHunterStepTask } from "../lib/pattern-hunter-types.js";

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

/** Derives this step's `summary` from Pattern Hunter's `/red-team` response.
 * Pass/fail verdicts, not new findings to list — `items` stays empty (the
 * factory's default), same as before #332. Factored out into its own plain
 * function (datacrew#85) so it's testable without a live `postPatternHunter`
 * call — see `tasks/pattern-hunter-red-team.test.ts`. */
export function buildRedTeamStepWork(response: Omit<RedTeamResult, "step">): {
  summary: string;
} {
  const nPassed = response.results.filter((r) => r.overall_pass).length;
  return { summary: `${nPassed}/${response.results.length} hypotheses passed red-team review` };
}

/**
 * Migrated onto `createPatternHunterStepTask` (datacrew#85, following #84's
 * tracer bullet). Node 4 is bespoke (zero mdrag calls, per `main.py`'s
 * module docstring) but still makes one Letta call that can 502 on an
 * unparseable/incomplete criteria set or a failed hypothesis missing a
 * `replacement_recommendation` — same reasoning as every other Pattern
 * Hunter node task, which is why this task doesn't override the factory's
 * `PATTERN_HUNTER_STEP_RETRY_DEFAULT`.
 */
export const patternHunterRedTeam = createPatternHunterStepTask<
  PatternHunterRedTeamPayload,
  Omit<RedTeamResult, "step">
>({
  id: "pattern-hunter-red-team",
  step: 4,
  label: "Red Team",
  run: async (payload) => {
    const response = await postPatternHunter<Omit<RedTeamResult, "step">>("red-team", {
      business_input: payload.business_input,
      hypothesis_cards: payload.hypothesis_cards,
    });

    return { response, ...buildRedTeamStepWork(response) };
  },
});
