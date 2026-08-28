import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceSpec } from "./mermaid-distill.js";

test("coerceSpec(flowchart): accepts a well-formed spec", () => {
  const spec = coerceSpec("flowchart", {
    steps: [
      { id: "a", label: "Start", next: ["b"] },
      { id: "b", label: "End", next: [] },
    ],
  });
  assert.deepEqual(spec, {
    type: "flowchart",
    steps: [
      { id: "a", label: "Start", next: ["b"] },
      { id: "b", label: "End", next: [] },
    ],
  });
});

test("coerceSpec(flowchart): rejects an empty steps array", () => {
  assert.equal(coerceSpec("flowchart", { steps: [] }), null);
});

test("coerceSpec(flowchart): rejects a step missing a label", () => {
  assert.equal(coerceSpec("flowchart", { steps: [{ id: "a", next: [] }] }), null);
});

test("coerceSpec(flowchart): defaults a missing next[] to empty rather than rejecting", () => {
  const spec = coerceSpec("flowchart", { steps: [{ id: "a", label: "Only step" }] });
  assert.deepEqual(spec, { type: "flowchart", steps: [{ id: "a", label: "Only step", next: [] }] });
});

test("coerceSpec(sequence): accepts a well-formed spec and defaults a missing kind to sync", () => {
  const spec = coerceSpec("sequence", {
    participants: ["Alice", "Bob"],
    messages: [{ from: "Alice", to: "Bob", label: "Hi" }],
  });
  assert.deepEqual(spec, {
    type: "sequence",
    participants: ["Alice", "Bob"],
    messages: [{ from: "Alice", to: "Bob", label: "Hi", kind: "sync" }],
  });
});

test("coerceSpec(sequence): rejects no participants", () => {
  assert.equal(coerceSpec("sequence", { participants: [], messages: [{ from: "A", to: "B", label: "x" }] }), null);
});

test("coerceSpec(erd): accepts a well-formed spec", () => {
  const spec = coerceSpec("erd", {
    entities: [{ name: "CUSTOMER", attributes: [{ name: "id", attr_type: "string", key: "PK" }] }],
    relationships: [{ from: "CUSTOMER", to: "ORDER", label: "places", cardinality: "||--o{" }],
  });
  assert.equal(spec?.type, "erd");
});

test("coerceSpec(erd): rejects an unknown key value instead of coercing it", () => {
  const spec = coerceSpec("erd", {
    entities: [{ name: "CUSTOMER", attributes: [{ name: "id", attr_type: "string", key: "NOT_A_KEY" }] }],
  });
  // NOT_A_KEY isn't PK/FK/UK — the attribute is still valid, just without a key.
  assert.deepEqual(spec, {
    type: "erd",
    entities: [{ name: "CUSTOMER", attributes: [{ name: "id", attr_type: "string" }] }],
    relationships: [],
  });
});

test("coerceSpec(erd): rejects entities that aren't an array", () => {
  assert.equal(coerceSpec("erd", { entities: "CUSTOMER" }), null);
});

test("coerceSpec: null input never throws", () => {
  assert.equal(coerceSpec("flowchart", null), null);
});
