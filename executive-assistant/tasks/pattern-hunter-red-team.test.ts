import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRedTeamStepWork } from "./pattern-hunter-red-team.js";
import type { HypothesisRedTeamResult, RedTeamResult } from "./pattern-hunter-red-team.js";

function redTeamCriteriaResult(over: Partial<HypothesisRedTeamResult> = {}): HypothesisRedTeamResult {
  return {
    hypothesis_title: "Faster quoting wins more jobs",
    overall_pass: true,
    criteria: [
      { criterion: "actionable_within_48h", passed: true, rationale: "Can be tested this week." },
      { criterion: "low_cost", passed: true, rationale: "No new tooling required." },
      { criterion: "addresses_fear", passed: true, rationale: "Directly targets lost bids." },
      { criterion: "has_opening_line", passed: true, rationale: "Ships with a script." },
    ],
    opening_line: "Want to win more bids without changing your prices?",
    replacement_recommendation: null,
    ...over,
  };
}

function redTeamResponse(
  over: Partial<Omit<RedTeamResult, "step">> = {}
): Omit<RedTeamResult, "step"> {
  return {
    status: "ok",
    business_input: "a plumbing company",
    results: [redTeamCriteriaResult()],
    usage: { input_tokens: 10, output_tokens: 20 },
    ...over,
  };
}

test("buildRedTeamStepWork summarizes how many hypotheses passed out of the total", () => {
  const work = buildRedTeamStepWork(
    redTeamResponse({
      results: [
        redTeamCriteriaResult({ overall_pass: true }),
        redTeamCriteriaResult({ overall_pass: false, hypothesis_title: "Other" }),
      ],
    })
  );
  assert.equal(work.summary, "1/2 hypotheses passed red-team review");
});

test("buildRedTeamStepWork summarizes 0/0 when there are no results", () => {
  const work = buildRedTeamStepWork(redTeamResponse({ results: [] }));
  assert.equal(work.summary, "0/0 hypotheses passed red-team review");
});

test("buildRedTeamStepWork summarizes a full pass", () => {
  const work = buildRedTeamStepWork(
    redTeamResponse({
      results: [redTeamCriteriaResult(), redTeamCriteriaResult({ hypothesis_title: "Other" })],
    })
  );
  assert.equal(work.summary, "2/2 hypotheses passed red-team review");
});

test("buildRedTeamStepWork never returns items — pass/fail verdicts aren't new findings", () => {
  const work = buildRedTeamStepWork(redTeamResponse());
  assert.equal("items" in work, false);
});
