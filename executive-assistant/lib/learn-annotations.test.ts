import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessmentMarkdown,
  missionMarkdown,
  resourceMarkdown,
  type LearnAssessmentPayload,
  type LearnMissionPayload,
  type LearnResourcePayload,
} from "./learn-annotations.js";

/**
 * These cover the `content` half of an Annotation, which is easy to treat as
 * cosmetic and isn't: `payload` is what code reads, `content` is what a human
 * and `query_rag` read. An Annotation with an empty body is retrievable only
 * by its title, which defeats the point of putting learn state somewhere
 * searchable in the first place.
 *
 * The rule they enforce is that the body is RENDERED from the payload rather
 * than passed in alongside it, so the two cannot drift.
 */

test("mission body carries the goal, not just the topic", () => {
  const p: LearnMissionPayload = {
    topic: "Snowflake OSI's semantic layer",
    goal: "decide whether to adopt it for our metrics layer",
  };
  const md = missionMarkdown(p);
  assert.match(md, /Snowflake OSI's semantic layer/);
  // The goal is what lesson difficulty keys off — a body that dropped it
  // would leave the searchable record less useful than the payload.
  assert.match(md, /decide whether to adopt it/);
});

test("mission body omits absent optional sections entirely", () => {
  const md = missionMarkdown({ topic: "t", goal: "g" });
  assert.doesNotMatch(md, /Why now/);
  assert.doesNotMatch(md, /Constraints/);
  assert.doesNotMatch(md, /Success criteria/);
  // One deliberate blank line after the heading, and no runs beyond it.
  assert.match(md, /^# Mission — t\n\n\*\*Goal:\*\* g$/);
});

test("mission body renders success criteria as a list", () => {
  const md = missionMarkdown({
    topic: "t",
    goal: "g",
    success_criteria: ["explain it to a colleague", "read a semantic model file"],
  });
  assert.match(md, /- explain it to a colleague/);
  assert.match(md, /- read a semantic model file/);
});

test("assessment body keeps misconceptions visibly separate from gaps", () => {
  const p: LearnAssessmentPayload = {
    topic: "semantic layers",
    level: "intermediate",
    gaps: ["metric definitions"],
    misconceptions: ["thinks a semantic layer is a caching layer"],
  };
  const md = assessmentMarkdown(p);
  assert.match(md, /\*\*Gaps\*\*/);
  assert.match(md, /teach by contradiction/);
  // The two must not be merged into one list — they need opposite teaching.
  const gapsAt = md.indexOf("metric definitions");
  const miscAt = md.indexOf("caching layer");
  assert.ok(gapsAt !== -1 && miscAt !== -1 && gapsAt !== miscAt);
});

test("assessment body shows low confidence when none was given", () => {
  // Mirrors the server-side default: an unevidenced placement should not read
  // as settled to a human either.
  const md = assessmentMarkdown({ topic: "t", level: "advanced" });
  assert.match(md, /\*\*Confidence:\*\* low/);
});

test("assessment body renders evidence with its verdict", () => {
  const md = assessmentMarkdown({
    topic: "t",
    level: "beginner",
    evidence: [
      { question: "What is a metric?", answer: "a number on a dashboard", verdict: "partial" },
    ],
  });
  assert.match(md, /What is a metric\?/);
  assert.match(md, /a number on a dashboard/);
  assert.match(md, /\*\*partial\*\*/);
});

test("resource body records the verdict and the URL", () => {
  const p: LearnResourcePayload = {
    url: "https://docs.example.com/semantic",
    title: "Semantic Layer Docs",
    verdict: "trusted",
    rationale: "first-party reference, versioned",
    resource_class: "knowledge",
  };
  const md = resourceMarkdown(p);
  assert.match(md, /Semantic Layer Docs/);
  assert.match(md, /trusted \(knowledge\)/);
  assert.match(md, /<https:\/\/docs\.example\.com\/semantic>/);
  assert.match(md, /first-party reference/);
});

test("a rejected resource still produces a usable body", () => {
  // Rejections are kept so the next hunt doesn't re-judge the same page —
  // a body that rendered as empty would make that record useless.
  const md = resourceMarkdown({
    url: "https://spam.example.com",
    verdict: "rejected",
    rationale: "SEO listicle, no primary sourcing",
  });
  assert.match(md, /rejected/);
  assert.match(md, /SEO listicle/);
  // Falls back to the URL when there's no title.
  assert.match(md, /# https:\/\/spam\.example\.com/);
});

test("resource body separates what it covers from what it does not", () => {
  const md = resourceMarkdown({
    url: "https://x.example",
    verdict: "trusted",
    covers: ["metric definitions"],
    gaps: ["governance", "row-level security"],
  });
  assert.match(md, /\*\*Covers\*\*/);
  assert.match(md, /\*\*Does not cover\*\*/);
  assert.match(md, /- governance/);
});
