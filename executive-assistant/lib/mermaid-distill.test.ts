import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceSpec, dedupeRelationships } from "./mermaid-distill.js";

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

// datacrew-site#219: the model reliably restates the same ERD relationship
// from both directions, which the real mermaid parser rejects. Verified as
// a coerceSpec-level integration (not just dedupeRelationships in
// isolation) so a regression here — e.g. someone dropping the dedup call
// from coerceErd — fails the same test that would have caught the original
// bug.
test("coerceSpec(erd): drops a reverse-direction restatement of the same relationship", () => {
  const spec = coerceSpec("erd", {
    entities: [
      { name: "AUTHOR", attributes: [{ name: "id", attr_type: "string", key: "PK" }] },
      { name: "POST", attributes: [{ name: "id", attr_type: "string", key: "PK" }] },
    ],
    relationships: [
      { from: "AUTHOR", to: "POST", label: "has", cardinality: "||--||" },
      { from: "POST", to: "AUTHOR", label: "belongs to", cardinality: "}o--||" },
    ],
  });
  assert.equal(spec?.type, "erd");
  assert.deepEqual((spec as { relationships: unknown[] }).relationships, [
    { from: "AUTHOR", to: "POST", label: "has", cardinality: "||--||" },
  ]);
});

test("coerceSpec(erd): keeps distinct relationships between different entity pairs", () => {
  const spec = coerceSpec("erd", {
    entities: [
      { name: "CUSTOMER", attributes: [{ name: "id", attr_type: "string", key: "PK" }] },
      { name: "ORDER", attributes: [{ name: "id", attr_type: "string", key: "PK" }] },
      { name: "PRODUCT", attributes: [{ name: "id", attr_type: "string", key: "PK" }] },
    ],
    relationships: [
      { from: "CUSTOMER", to: "ORDER", label: "places", cardinality: "||--o{" },
      { from: "ORDER", to: "PRODUCT", label: "contains", cardinality: "}o--o{" },
    ],
  });
  assert.equal((spec as { relationships: unknown[] }).relationships.length, 2);
});

// datacrew-site#219, second defect: a truncated cardinality token (e.g.
// "}--||" instead of "}o--||") is real mermaid.parse()-rejected but was
// passing coerceErd's shape-check since it only required `typeof === "string"`.
// This surfaced only after the dedup fix above stopped masking it — the eval
// harness re-run showed the exact same run failing on a *different* line
// once the duplicate was gone.
test("coerceSpec(erd): drops (not the whole spec) a relationship with a truncated cardinality token", () => {
  // Whole-spec rejection would hard-fail the pipeline run — distillTranscript
  // has no retry loop of its own to safely redo just this piece. Dropping
  // the one bad relationship keeps everything else valid and returnable.
  const spec = coerceSpec("erd", {
    entities: [
      { name: "POST", attributes: [{ name: "id", attr_type: "string", key: "PK" }] },
      { name: "COMMENT", attributes: [{ name: "id", attr_type: "string", key: "PK" }] },
    ],
    relationships: [{ from: "POST", to: "COMMENT", label: "has", cardinality: "}--||" }],
  });
  assert.equal(spec?.type, "erd");
  assert.deepEqual((spec as { relationships: unknown[] }).relationships, []);
});

test("coerceSpec(erd): accepts every valid cardinality token combination", () => {
  for (const cardinality of ["||--||", "|o--o|", "}o--o{", "}|--|{", "||--o{"]) {
    const spec = coerceSpec("erd", {
      entities: [{ name: "A", attributes: [{ name: "id", attr_type: "string" }] }],
      relationships: [{ from: "A", to: "B", label: "x", cardinality }],
    });
    assert.equal(spec?.type, "erd", `expected ${cardinality} to be accepted`);
  }
});

test("coerceSpec(erd): accepts the '..' (non-identifying) line style", () => {
  const spec = coerceSpec("erd", {
    entities: [{ name: "A", attributes: [{ name: "id", attr_type: "string" }] }],
    relationships: [{ from: "A", to: "B", label: "x", cardinality: "||..o{" }],
  });
  assert.equal(spec?.type, "erd");
});

test("dedupeRelationships: first occurrence wins regardless of cardinality (dis)agreement", () => {
  const out = dedupeRelationships([
    { from: "A", to: "B", label: "x", cardinality: "||--||" },
    { from: "B", to: "A", label: "y", cardinality: "}o--o{" },
    { from: "A", to: "C", label: "z", cardinality: "||--||" },
  ]);
  assert.deepEqual(out, [
    { from: "A", to: "B", label: "x", cardinality: "||--||" },
    { from: "A", to: "C", label: "z", cardinality: "||--||" },
  ]);
});
