import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHypothesesStepWork } from "./pattern-hunter-hypotheses.js";
import type { HypothesesResult, HypothesisCard } from "./pattern-hunter-hypotheses.js";

function hypothesisCard(over: Partial<HypothesisCard> = {}): HypothesisCard {
  return {
    title: "Faster quoting wins more jobs",
    hypothesis_statement: "Operators who quote within an hour close more bids.",
    confirmation_questions: ["How long does a typical quote take you today?"],
    done_for_you_asset: {
      asset_type: "quoting filter",
      description: "A checklist to triage inbound jobs before quoting.",
      content: "1. Confirm scope. 2. Confirm timeline. 3. Confirm budget.",
    },
    ...over,
  };
}

function hypothesesResponse(
  over: Partial<Omit<HypothesesResult, "step">> = {}
): Omit<HypothesesResult, "step"> {
  return {
    status: "ok",
    business_input: "a plumbing company",
    hypothesis_cards: [hypothesisCard()],
    usage: { input_tokens: 10, output_tokens: 20 },
    ...over,
  };
}

test("buildHypothesesStepWork summarizes the number of hypothesis cards generated", () => {
  const work = buildHypothesesStepWork(
    hypothesesResponse({ hypothesis_cards: [hypothesisCard(), hypothesisCard({ title: "Other" })] })
  );
  assert.equal(work.summary, "2 hypothesis cards generated");
});

test("buildHypothesesStepWork summarizes zero cards when none were generated", () => {
  const work = buildHypothesesStepWork(hypothesesResponse({ hypothesis_cards: [] }));
  assert.equal(work.summary, "0 hypothesis cards generated");
});

test("buildHypothesesStepWork never returns items — no PatternResult variant fits a hypothesis card", () => {
  const work = buildHypothesesStepWork(hypothesesResponse());
  assert.equal("items" in work, false);
});
