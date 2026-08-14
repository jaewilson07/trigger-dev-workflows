import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEvidenceItems,
  buildPainPointsStepWork,
  deriveEvidenceTags,
  deriveSourceName,
} from "./pattern-hunter-pain-points.js";
import type { EvidenceSource, PainPoint, PainPointsResult } from "./pattern-hunter-pain-points.js";

function painPoint(over: Partial<PainPoint> = {}): PainPoint {
  return {
    rank: 1,
    category: "cash-flow bottleneck",
    pain_point: "Operators can't quote fast enough to win jobs.",
    illustrative_quotes: ["We lose bids because our quotes take too long."],
    ...over,
  };
}

function evidenceSource(over: Partial<EvidenceSource> = {}): EvidenceSource {
  return {
    id: "ev-1",
    title: "Operators complain about slow quoting",
    url: "https://www.reddit.com/r/smallbusiness/abc",
    snippet: "We lose bids because our quotes take too long.",
    ...over,
  };
}

function painPointsResponse(
  over: Partial<Omit<PainPointsResult, "step">> = {}
): Omit<PainPointsResult, "step"> {
  return {
    status: "ok",
    business_input: "a plumbing company",
    pain_points: [painPoint()],
    quotes_disclaimer: "Quotes lightly trimmed for length.",
    evidence_sources: [evidenceSource()],
    company_evidence_sources: [],
    industry_evidence_sources: [evidenceSource()],
    company_evidence_found: false,
    industry_evidence_found: true,
    usage: { input_tokens: 10, output_tokens: 20 },
    ...over,
  };
}

test("deriveSourceName strips www. and returns the bare hostname", () => {
  assert.equal(deriveSourceName("https://www.reddit.com/r/smallbusiness/abc"), "reddit.com");
});

test("deriveSourceName falls back to the raw url when it doesn't parse", () => {
  assert.equal(deriveSourceName("not a url"), "not a url");
});

test("deriveSourceName falls back to a placeholder for an empty/unparseable url", () => {
  assert.equal(deriveSourceName("   "), "unknown source");
});

test("deriveEvidenceTags returns undefined when the source has no snippet", () => {
  const result = deriveEvidenceTags(evidenceSource({ snippet: "" }), [painPoint()]);
  assert.equal(result, undefined);
});

test("deriveEvidenceTags returns undefined when no pain point's quote overlaps the snippet", () => {
  const result = deriveEvidenceTags(
    evidenceSource({ snippet: "completely unrelated text" }),
    [painPoint()]
  );
  assert.equal(result, undefined);
});

test("deriveEvidenceTags tags the category whose illustrative quote overlaps the snippet", () => {
  const result = deriveEvidenceTags(evidenceSource(), [painPoint()]);
  assert.deepEqual(result, ["cash-flow bottleneck"]);
});

test("deriveEvidenceTags matches case-insensitively in either substring direction", () => {
  const result = deriveEvidenceTags(
    evidenceSource({ snippet: "WE LOSE BIDS BECAUSE OUR QUOTES TAKE TOO LONG. (full context)" }),
    [painPoint()]
  );
  assert.deepEqual(result, ["cash-flow bottleneck"]);
});

test("deriveEvidenceTags can tag more than one category when multiple pain points match", () => {
  const shared = "our team is stretched too thin to keep up";
  const result = deriveEvidenceTags(evidenceSource({ snippet: shared }), [
    painPoint({ category: "cash-flow bottleneck", illustrative_quotes: [shared] }),
    painPoint({ category: "hiring nightmare", illustrative_quotes: [shared] }),
  ]);
  assert.deepEqual(new Set(result), new Set(["cash-flow bottleneck", "hiring nightmare"]));
});

test("buildEvidenceItems maps every evidence_source onto an EvidenceResult, omitting tags when none match", () => {
  const items = buildEvidenceItems("a plumbing company", {
    pain_points: [painPoint()],
    evidence_sources: [evidenceSource(), evidenceSource({ id: "ev-2", snippet: "unrelated" })],
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    type: "evidence",
    id: "ev-1",
    headline: "Operators complain about slow quoting",
    quote: "We lose bids because our quotes take too long.",
    source_name: "reddit.com",
    source_url: "https://www.reddit.com/r/smallbusiness/abc",
    relevance: "Cited operator pain-point evidence for a plumbing company",
    tags: ["cash-flow bottleneck"],
  });
  assert.equal("tags" in items[1]!, false);
});

test("buildPainPointsStepWork summarizes counts and builds evidence items from the response", () => {
  const response = painPointsResponse({
    pain_points: [painPoint(), painPoint({ rank: 2, category: "hiring nightmare" })],
    evidence_sources: [evidenceSource(), evidenceSource({ id: "ev-2" })],
  });
  const work = buildPainPointsStepWork("a plumbing company", response);
  assert.equal(work.summary, "2 operator pain points found, 2 evidence sources cited");
  assert.equal(work.items.length, 2);
  assert.equal(work.items[0]!.type, "evidence");
});

test("buildPainPointsStepWork summarizes zero counts when nothing was found", () => {
  const response = painPointsResponse({ pain_points: [], evidence_sources: [] });
  const work = buildPainPointsStepWork("a plumbing company", response);
  assert.equal(work.summary, "0 operator pain points found, 0 evidence sources cited");
  assert.deepEqual(work.items, []);
});
