import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBriefBlocks, chunkBlocks } from "./slack-blocks.js";
import type { TriageResult } from "../tasks/triage-emails.js";
import type { TopicSearchResult } from "./mdrag-topic-search.js";

function email(over: Partial<TriageResult> = {}): TriageResult {
  return {
    email_id: "m1",
    sender: "a@example.com",
    subject: "Subject",
    category: "Notification",
    proposed_action: "keep",
    one_line_summary: "A summary.",
    confidence: 0.9,
    ...over,
  };
}

const textOf = (blocks: unknown[]): string => JSON.stringify(blocks);

test("respects Slack's hard block limits", () => {
  // Sections cap at 3000 chars and headers at 150; exceeding either is a 400
  // (invalid_blocks), not a truncation, so this is a correctness bound.
  const many = Array.from({ length: 120 }, (_, i) =>
    email({ email_id: `m${i}`, subject: "S".repeat(200), one_line_summary: "y".repeat(200) })
  );
  const blocks = buildBriefBlocks(many, []);
  for (const b of blocks as Array<{ type: string; text?: { text: string } }>) {
    if (b.type === "section") assert.ok(b.text!.text.length <= 3000, `section ${b.text!.text.length}`);
    if (b.type === "header") assert.ok(b.text!.text.length <= 150, `header ${b.text!.text.length}`);
  }
  for (const msg of chunkBlocks(blocks)) {
    assert.ok(msg.length <= 50, `message had ${msg.length} blocks, Slack allows 50`);
  }
});

test("escapes Slack control characters in user content", () => {
  // Real senders arrive as `Name <addr@example.com>`. Unescaped, Slack parses
  // the angle brackets as a malformed link and silently drops the text.
  const blocks = buildBriefBlocks([email({ sender: "Jae <jae@example.com>", subject: "A & B <prod>" })], []);
  const s = textOf(blocks);
  assert.ok(s.includes("&lt;jae@example.com&gt;"), "sender angle brackets escaped");
  assert.ok(s.includes("A &amp; B &lt;prod&gt;"), "subject ampersand and brackets escaped");
});

test("uses Slack link syntax, not markdown", () => {
  const topics: TopicSearchResult[] = [
    { topic: "Domo", results: [{ title: "Domo sells assets", url: "https://example.com/a", snippet: "News." }] },
  ] as TopicSearchResult[];
  const s = textOf(buildBriefBlocks([email()], topics));
  assert.ok(s.includes("<https://example.com/a|Domo sells assets>"), "renders <url|label>");
  assert.ok(!s.includes("](" ), "no markdown link syntax survives");
});

test("never emits markdown headings", () => {
  // Slack has no heading syntax; `#` renders literally. Headings must be
  // `header` blocks instead.
  const blocks = buildBriefBlocks([email()], []);
  const s = textOf(blocks);
  assert.ok(!s.includes("# "), "no '# ' heading text");
  assert.equal((blocks[0] as { type: string }).type, "header");
});

test("surfaces actionable categories above the long tail", () => {
  const blocks = buildBriefBlocks(
    [
      ...Array.from({ length: 20 }, (_, i) => email({ email_id: `n${i}`, category: "Notification" })),
      email({ email_id: "c1", category: "Client" }),
      email({ email_id: "a1", category: "Action Required" }),
    ],
    []
  );
  const s = textOf(blocks);
  assert.ok(
    s.indexOf("Action Required") < s.indexOf("*Client*") && s.indexOf("*Client*") < s.indexOf("*Notification*"),
    "Action Required, then Client, then the 20-item Notification tail"
  );
});

test("flags a degraded verdict rather than showing it as a low score", () => {
  // confidence 0 is gateway-llm's signal that triage did not really happen.
  const s = textOf(buildBriefBlocks([email({ confidence: 0 })], []));
  assert.ok(s.includes("not triaged"), "degraded verdict called out");
});

test("chunks on block boundaries without stranding dividers", () => {
  const blocks = buildBriefBlocks(
    Array.from({ length: 200 }, (_, i) => email({ email_id: `m${i}`, category: `Cat${i % 40}` })),
    []
  );
  const messages = chunkBlocks(blocks);
  assert.ok(messages.length > 1, "long brief splits");
  for (const [i, msg] of messages.entries()) {
    assert.notEqual((msg[msg.length - 1] as { type: string }).type, "divider", `msg ${i} ends on a divider`);
    if (i > 0) assert.notEqual((msg[0] as { type: string }).type, "divider", `msg ${i} starts on a divider`);
  }
});

test("handles an empty inbox without emitting empty blocks", () => {
  const blocks = buildBriefBlocks([], []);
  assert.ok(blocks.length >= 1);
  for (const b of blocks as Array<{ type: string; text?: { text: string } }>) {
    if (b.type === "section") assert.ok(b.text!.text.trim().length > 0, "no empty section");
  }
});

test("omits the category roll-up when it would just repeat the section header", () => {
  const single = buildBriefBlocks(
    Array.from({ length: 25 }, (_, i) => email({ email_id: `n${i}`, category: "Notification" })),
    []
  );
  const rollups = (single as Array<{ type: string; text?: { text: string } }>).filter(
    (b) => b.type === "section" && /^\*Notification\* 25$/.test(b.text!.text)
  );
  assert.equal(rollups.length, 0, "no duplicate roll-up for a single category");

  const multi = buildBriefBlocks([email({ category: "Client" }), email({ category: "Notification" })], []);
  assert.ok(textOf(multi).includes("*Client* 1"), "roll-up kept when categories differ");
});
