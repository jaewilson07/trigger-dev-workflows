import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMermaidBlock, renderErdDeterministic } from "./mermaid-render.js";
import type { ErdSpec } from "./mermaid-types.js";

test("extractMermaidBlock: pulls the fenced block out of surrounding prose", () => {
  const reply = 'Here you go:\n```mermaid\nflowchart TD\nA-->B\n```\nLet me know if you want changes.';
  assert.equal(extractMermaidBlock(reply), "flowchart TD\nA-->B");
});

test("extractMermaidBlock: works with a bare fence (no 'mermaid' tag)", () => {
  assert.equal(extractMermaidBlock("```\nflowchart TD\nA-->B\n```"), "flowchart TD\nA-->B");
});

test("extractMermaidBlock: returns null when there's no fence at all", () => {
  assert.equal(extractMermaidBlock("I'm not sure what you mean."), null);
});

test("extractMermaidBlock: returns null for an empty fenced block", () => {
  assert.equal(extractMermaidBlock("```mermaid\n\n```"), null);
});

// datacrew-site#219: ERD render skips the LLM entirely (see renderStateless's
// doc comment) — these lock in the exact syntax shape, especially the
// attribute field order the render-stage LLM used to swap (name/type).
const BLOG_SPEC: ErdSpec = {
  type: "erd",
  entities: [
    {
      name: "AUTHOR",
      attributes: [
        { name: "email", attr_type: "string", key: "PK" },
        { name: "name", attr_type: "string" },
      ],
    },
    {
      name: "POST",
      attributes: [
        { name: "title", attr_type: "string" },
        { name: "author_id", attr_type: "string", key: "FK" },
      ],
    },
  ],
  relationships: [{ from: "AUTHOR", to: "POST", label: "has", cardinality: "||--|{" }],
};

test("renderErdDeterministic: attribute lines are <type> <name> [<key>], not the spec's own name-first field order", () => {
  const out = renderErdDeterministic(BLOG_SPEC);
  assert.match(out, /^erDiagram/);
  assert.match(out, /string email PK/);
  assert.match(out, /string name$/m);
  assert.doesNotMatch(out, /email string/); // the exact swap the LLM renderer used to produce
});

test("renderErdDeterministic: relationship line carries the spec's cardinality through unchanged", () => {
  const out = renderErdDeterministic(BLOG_SPEC);
  assert.match(out, /^AUTHOR \|\|--\|\{ POST : has$/m);
});

test("renderErdDeterministic: an entity with no attributes gets no block, just appears in its relationship line", () => {
  const spec: ErdSpec = {
    type: "erd",
    entities: [{ name: "TAG", attributes: [] }, { name: "POST", attributes: [] }],
    relationships: [{ from: "POST", to: "TAG", label: "has", cardinality: "}o--o{" }],
  };
  const out = renderErdDeterministic(spec);
  assert.doesNotMatch(out, /^TAG \{$/m); // no attribute block for either entity
  assert.doesNotMatch(out, /^POST \{$/m);
  assert.match(out, /^POST \}o--o\{ TAG : has$/m);
});

test("renderErdDeterministic: quotes an entity/attribute/label containing a space", () => {
  const spec: ErdSpec = {
    type: "erd",
    entities: [{ name: "LINE ITEM", attributes: [{ name: "unit price", attr_type: "decimal" }] }],
    relationships: [],
  };
  const out = renderErdDeterministic(spec);
  assert.match(out, /^"LINE ITEM" \{$/m);
  assert.match(out, /decimal "unit price"/);
});
