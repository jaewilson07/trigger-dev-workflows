import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceClassifyResult } from "./mermaid-classify.js";

test("coerceClassifyResult: accepts a well-formed classification", () => {
  const result = coerceClassifyResult({ graph_type: "sequence", confidence: 0.8, rationale: "actors" });
  assert.deepEqual(result, { graph_type: "sequence", confidence: 0.8, rationale: "actors" });
});

test("coerceClassifyResult: rejects an invalid graph_type", () => {
  assert.equal(coerceClassifyResult({ graph_type: "pie chart", confidence: 0.9 }), null);
});

test("coerceClassifyResult: rejects a missing graph_type", () => {
  assert.equal(coerceClassifyResult({ confidence: 0.9 }), null);
});

test("coerceClassifyResult: rejects null input", () => {
  assert.equal(coerceClassifyResult(null), null);
});

test("coerceClassifyResult: clamps out-of-range confidence and defaults missing fields", () => {
  const result = coerceClassifyResult({ graph_type: "erd", confidence: 4.2 });
  assert.deepEqual(result, { graph_type: "erd", confidence: 1, rationale: "" });
});

test("coerceClassifyResult: clamps negative confidence to zero", () => {
  const result = coerceClassifyResult({ graph_type: "flowchart", confidence: -1 });
  assert.equal(result?.confidence, 0);
});
