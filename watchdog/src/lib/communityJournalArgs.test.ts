import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommunityJournalArgs } from "./communityJournalArgs.js";

const base = {
  scriptPath: "/tmp/main.py",
  days: 7,
  groupId: "datacrew",
  asOfIso: "2026-09-07T07:00:00.000Z",
  dryRun: false,
};

test("always passes --synthesizer letta, never relies on main.py's own 'auto' default", () => {
  // 'auto' picks headless `claude -p`, which needs the claude CLI's cached
  // OAuth session on PATH inside this Trigger.dev container — unverified
  // (llm_client.py's "Known gap"). This task instead always asks for the
  // letta gateway synthesizer, authenticated with the same DATACREW_API_TOKEN
  // this task already fetches for its own mdrag writes.
  const args = buildCommunityJournalArgs(base);
  const idx = args.indexOf("--synthesizer");
  assert.notEqual(idx, -1, "--synthesizer flag is present");
  assert.equal(args[idx + 1], "letta");
});

test("never passes --synthesizer api (the ANTHROPIC_API_KEY-requiring path)", () => {
  const args = buildCommunityJournalArgs(base);
  assert.equal(args.includes("api"), false);
});

test("includes --dry-run when dryRun is true", () => {
  const args = buildCommunityJournalArgs({ ...base, dryRun: true });
  assert.ok(args.includes("--dry-run"));
});

test("omits --dry-run when dryRun is false", () => {
  const args = buildCommunityJournalArgs({ ...base, dryRun: false });
  assert.equal(args.includes("--dry-run"), false);
});

test("includes --interesting only when provided", () => {
  const withIt = buildCommunityJournalArgs({ ...base, interesting: "foo bar" });
  const idx = withIt.indexOf("--interesting");
  assert.notEqual(idx, -1);
  assert.equal(withIt[idx + 1], "foo bar");

  const without = buildCommunityJournalArgs(base);
  assert.equal(without.includes("--interesting"), false);
});

test("carries the script path, days, group-id, and as-of straight through", () => {
  const args = buildCommunityJournalArgs(base);
  assert.equal(args[0], base.scriptPath);
  assert.equal(args[args.indexOf("--days") + 1], String(base.days));
  assert.equal(args[args.indexOf("--group-id") + 1], base.groupId);
  assert.equal(args[args.indexOf("--as-of") + 1], base.asOfIso);
});
