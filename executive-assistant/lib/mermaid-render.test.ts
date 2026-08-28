import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMermaidBlock } from "./mermaid-render.js";

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
