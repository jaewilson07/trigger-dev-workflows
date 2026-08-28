import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMermaidSyntax } from "./mermaid-validate.js";

// Real parser, real jsdom shim — no mocking. This is the exact bug class
// datacrew-site's route hit in production (an unescaped double-quote inside
// an unquoted label), so it stays a live behavioral test rather than a
// stand-in for one.

test("validateMermaidSyntax: accepts a well-formed flowchart", async () => {
  const result = await validateMermaidSyntax('flowchart TD\nA["User clicks \'Forgot password\'"]-->B');
  assert.equal(result.valid, true);
});

test("validateMermaidSyntax: rejects an unescaped double-quote inside an unquoted label", async () => {
  const result = await validateMermaidSyntax('flowchart TD\nA[User clicks "Forgot password"]-->B');
  assert.equal(result.valid, false);
  assert.ok(result.error);
});

test("validateMermaidSyntax: accepts a well-formed sequence diagram", async () => {
  const result = await validateMermaidSyntax("sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Hi");
  assert.equal(result.valid, true);
});

test("validateMermaidSyntax: accepts a well-formed ER diagram", async () => {
  const result = await validateMermaidSyntax(
    "erDiagram\nCUSTOMER ||--o{ ORDER : places\nCUSTOMER { string id PK }"
  );
  assert.equal(result.valid, true);
});

test("validateMermaidSyntax: rejects garbage text outright", async () => {
  const result = await validateMermaidSyntax("this is not a diagram at all");
  assert.equal(result.valid, false);
});
