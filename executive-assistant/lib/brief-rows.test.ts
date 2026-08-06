import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMO_BRIEF_COLUMNS, briefRows } from "./brief-rows.js";
import { toCsv } from "./domo-dataset.js";
import type { BriefResearch } from "./brief-delivery.js";
import type { TriageResult } from "../tasks/triage-emails.js";

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

function research(over: Partial<BriefResearch> = {}): BriefResearch {
  return {
    date: "2026-08-04",
    ownerEmail: "jae@datacrew.space",
    emailCount: 1,
    triageResults: [email()],
    topicResults: [
      {
        topic: "Domo",
        results: [
          { title: "Domo sells assets", url: "https://example.com/a", snippet: "News.", source: "mdrag/searxng" },
        ],
        searched_at: "2026-08-04T13:00:00.000Z",
      },
    ],
    researched_at: "2026-08-04T13:00:00.000Z",
    ...over,
  };
}

test("every row has exactly one cell per declared column", () => {
  // Domo maps headerless CSV by POSITION against the dataset schema, so a row
  // of the wrong width silently shifts every later column.
  for (const row of briefRows(research())) {
    assert.equal(row.length, DOMO_BRIEF_COLUMNS.length);
  }
});

test("emits a summary row, then inbox rows, then topic rows", () => {
  const sectionIndex = DOMO_BRIEF_COLUMNS.indexOf("section");
  const sections = briefRows(research()).map((row) => row[sectionIndex]);
  assert.deepEqual(sections, ["summary", "inbox", "topic"]);
});

test("carries the researched date, not today's", () => {
  // A run that crosses midnight, or a re-delivery of yesterday's research,
  // must still write the day it researched.
  const dateIndex = DOMO_BRIEF_COLUMNS.indexOf("brief_date");
  for (const row of briefRows(research({ date: "2026-01-01" }))) {
    assert.equal(row[dateIndex], "2026-01-01");
  }
});

test("quotes CSV fields that would otherwise break the row", () => {
  // Subjects with commas and snippets with newlines are the common case, not
  // an edge case -- unquoted, either one desynchronises the whole upload.
  const rows = briefRows(
    research({
      triageResults: [
        email({ subject: 'Re: budget, "final"', one_line_summary: "line one\nline two" }),
      ],
    })
  );
  const csv = toCsv(rows);
  assert.ok(csv.includes('"Re: budget, ""final"""'), csv);
  assert.ok(csv.includes('"line one\nline two"'), csv);
  // One record per row plus the embedded newline: 3 rows -> 4 physical lines.
  assert.equal(csv.split("\n").length, rows.length + 1);
});
