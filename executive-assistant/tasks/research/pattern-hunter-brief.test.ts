import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBriefStepWork, buildRecommendationItems } from "./pattern-hunter-brief.js";
import type { BriefRecommendation, BriefResult } from "./pattern-hunter-brief.js";

function briefRecommendation(over: Partial<BriefRecommendation> = {}): BriefRecommendation {
  return {
    type: "recommendation",
    relevance: "Cuts the time between job request and a sent quote.",
    action: "Adopt a same-day quoting SLA for inbound leads.",
    derived_from: ["ev-1"],
    tags: null,
    ...over,
  };
}

function briefResponse(over: Partial<Omit<BriefResult, "step">> = {}): Omit<BriefResult, "step"> {
  return {
    status: "ok",
    business_input: "a plumbing company",
    recommendations: [briefRecommendation()],
    answer_found: true,
    complete_answer_found: true,
    missing_required_fields: [],
    synthesis_narrative: "",
    ...over,
  };
}

test("buildRecommendationItems maps recommendations 1:1, adding the recommendation discriminant", () => {
  const items = buildRecommendationItems([briefRecommendation()]);
  assert.deepEqual(items, [
    {
      type: "recommendation",
      relevance: "Cuts the time between job request and a sent quote.",
      action: "Adopt a same-day quoting SLA for inbound leads.",
      derived_from: ["ev-1"],
    },
  ]);
});

test("buildRecommendationItems omits tags when null or empty", () => {
  const items = buildRecommendationItems([
    briefRecommendation({ tags: null }),
    briefRecommendation({ tags: [] }),
  ]);
  assert.equal("tags" in items[0]!, false);
  assert.equal("tags" in items[1]!, false);
});

test("buildRecommendationItems carries tags through when present", () => {
  const items = buildRecommendationItems([briefRecommendation({ tags: ["cash-flow bottleneck"] })]);
  assert.deepEqual(items[0]!.tags, ["cash-flow bottleneck"]);
});

test("buildBriefStepWork summarizes a grounded answer with a plural recommendation count", () => {
  const work = buildBriefStepWork(
    briefResponse({
      answer_found: true,
      recommendations: [briefRecommendation(), briefRecommendation({ action: "Other" })],
    })
  );
  assert.equal(work.summary, "2 grounded recommendations");
  assert.equal(work.items.length, 2);
});

test("buildBriefStepWork summarizes a grounded answer with a singular recommendation count", () => {
  const work = buildBriefStepWork(briefResponse({ answer_found: true, recommendations: [briefRecommendation()] }));
  assert.equal(work.summary, "1 grounded recommendation");
});

test("buildBriefStepWork summarizes a refusal, listing the missing required fields", () => {
  const work = buildBriefStepWork(
    briefResponse({
      answer_found: false,
      recommendations: [],
      missing_required_fields: ["pain_points", "hypothesis_cards"],
    })
  );
  assert.equal(work.summary, "No recommendations could be grounded (missing: pain_points, hypothesis_cards)");
  assert.deepEqual(work.items, []);
});

test("buildBriefStepWork summarizes a refusal without a missing-fields parenthetical when none are listed", () => {
  const work = buildBriefStepWork(
    briefResponse({ answer_found: false, recommendations: [], missing_required_fields: [] })
  );
  assert.equal(work.summary, "No recommendations could be grounded");
});

test("buildBriefStepWork carries synthesis_narrative through as narrative", () => {
  const work = buildBriefStepWork(briefResponse({ synthesis_narrative: "Operators are quote-bottlenecked." }));
  assert.equal(work.narrative, "Operators are quote-bottlenecked.");
});

test("buildBriefStepWork omits narrative entirely (not an empty string) when Pattern Hunter didn't produce one", () => {
  const work = buildBriefStepWork(briefResponse({ synthesis_narrative: "" }));
  assert.equal("narrative" in work, false);
});
