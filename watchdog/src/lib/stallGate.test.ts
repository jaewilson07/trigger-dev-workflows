import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRows,
  formatDigest,
  needsAgent,
  signalsFor,
} from "./stallGate.js";
import type { GateIssue, GateRun, LastMessage } from "./stallGate.js";

const NOW = new Date("2026-10-24T15:00:00Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

let seq = 0;
const issue = (over: Partial<GateIssue> = {}): GateIssue => {
  seq += 1;
  return {
    id: `id-${seq}`,
    identifier: `DAT-${seq}`,
    title: `Issue ${seq}`,
    status: "in_progress",
    projectId: "p1",
    assigneeAgentId: "a1",
    assigneeUserId: null,
    lastActivityAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    ...over,
  };
};
const run = (i: GateIssue, over: Partial<GateRun> = {}): GateRun => ({
  id: `r-${Math.random()}`,
  agentId: "a1",
  status: "succeeded",
  errorCode: null,
  error: null,
  createdAt: hoursAgo(2),
  issueId: i.id,
  ...over,
});

test("healthy in-progress work has no signals", () => {
  const i = issue();
  assert.deepEqual(signalsFor(i, [run(i)], 0, NOW), []);
});

test("orphaned: in_progress, last run orphaned, nothing live", () => {
  const i = issue();
  assert.deepEqual(
    signalsFor(
      i,
      [run(i, { status: "interrupted", errorCode: "orphaned_running_run" })],
      0,
      NOW,
    ),
    ["orphaned"],
  );
});

test("orphaned is not flagged when a fresh run is already live", () => {
  const i = issue();
  const runs = [
    run(i, {
      status: "interrupted",
      errorCode: "orphaned_running_run",
      createdAt: hoursAgo(2),
    }),
    run(i, { status: "running", createdAt: hoursAgo(0.1) }),
  ];
  assert.deepEqual(signalsFor(i, runs, 0, NOW), []);
});

test("stranded queue: a run queued more than 30 minutes", () => {
  const i = issue({ status: "todo" });
  assert.deepEqual(
    signalsFor(
      i,
      [run(i, { status: "queued", createdAt: hoursAgo(1) })],
      0,
      NOW,
    ),
    ["stranded_queue"],
  );
  assert.deepEqual(
    signalsFor(
      i,
      [run(i, { status: "queued", createdAt: hoursAgo(0.2) })],
      0,
      NOW,
    ),
    [],
  );
});

test("out of tokens: quota and org spend-cap failures", () => {
  const i = issue({ status: "todo" });
  assert.ok(
    signalsFor(
      i,
      [run(i, { status: "failed", errorCode: "provider_quota" })],
      0,
      NOW,
    ).includes("out_of_tokens"),
  );
  const cap = run(i, {
    status: "failed",
    errorCode: "acpx_turn_failed",
    error: "You've hit your org's monthly spend limit",
  });
  assert.ok(signalsFor(i, [cap], 0, NOW).includes("out_of_tokens"));
});

test("stale block only after 24h without activity", () => {
  assert.deepEqual(
    signalsFor(
      issue({ status: "blocked", lastActivityAt: hoursAgo(30) }),
      [],
      0,
      NOW,
    ),
    ["stale_block"],
  );
  assert.deepEqual(
    signalsFor(
      issue({ status: "blocked", lastActivityAt: hoursAgo(5) }),
      [],
      0,
      NOW,
    ),
    [],
  );
});

test("idle: in_review with no activity for 24h and nothing live", () => {
  const i = issue({ status: "in_review", lastActivityAt: hoursAgo(40) });
  assert.deepEqual(signalsFor(i, [], 0, NOW), ["idle"]);
  assert.deepEqual(
    signalsFor(
      i,
      [run(i, { status: "running", createdAt: hoursAgo(0.1) })],
      0,
      NOW,
    ),
    [],
  );
});

test("a pending card replaces idle/stale_block: waiting on Jae is not broken", () => {
  assert.deepEqual(
    signalsFor(
      issue({ status: "blocked", lastActivityAt: hoursAgo(72) }),
      [],
      1,
      NOW,
    ),
    ["needs_jae"],
  );
  assert.deepEqual(
    signalsFor(
      issue({ status: "in_review", lastActivityAt: hoursAgo(72) }),
      [],
      1,
      NOW,
    ),
    ["needs_jae"],
  );
});

test("retries_exhausted: Paperclip's own retry-budget note, nothing live", () => {
  const i = issue({ status: "blocked", lastActivityAt: hoursAgo(40) });
  const note = {
    at: hoursAgo(40),
    author: "system",
    excerpt:
      "Paperclip retried this issue's run after it ended without finishing, but the bounded retry budget is spent and",
  };
  assert.deepEqual(signalsFor(i, [], 0, NOW, note), ["retries_exhausted"]);
  assert.deepEqual(
    signalsFor(i, [], 0, NOW, { ...note, author: "SrTechDeveloper" }),
    ["stale_block"],
  );
});

test("needs_jae comes from pending cards and does not wake the agent", () => {
  const i = issue({ status: "in_review" });
  const rows = buildRows(
    [i],
    [],
    new Map(),
    new Map([[i.id, 2]]),
    { projects: new Map(), agents: new Map() },
    NOW,
  );
  assert.deepEqual(rows[0].signals, ["needs_jae"]);
  assert.equal(needsAgent(rows).length, 0);
});

test("needsAgent picks only agent-resumable signals", () => {
  const broken = issue({ status: "blocked", lastActivityAt: hoursAgo(48) });
  const fine = issue();
  const rows = buildRows(
    [broken, fine],
    [],
    new Map(),
    new Map(),
    { projects: new Map(), agents: new Map() },
    NOW,
  );
  assert.deepEqual(
    needsAgent(rows).map((r) => r.issue.identifier),
    [broken.identifier],
  );
});

test("digest: mentions Jae only when something waits on him; flagged projects first", () => {
  const a = issue({ projectId: "p1" });
  const b = issue({
    projectId: "p2",
    status: "blocked",
    lastActivityAt: hoursAgo(48),
  });
  const last: Map<string, LastMessage | null> = new Map([
    [
      a.id,
      { at: hoursAgo(3), author: "SrTechDeveloper", excerpt: "PR opened" },
    ],
  ]);
  const dir = {
    projects: new Map([
      ["p1", "alpha"],
      ["p2", "beta"],
    ]),
    agents: new Map([["a1", "SrTechDeveloper"]]),
  };
  const quiet = formatDigest(
    buildRows([a, b], [], last, new Map(), dir, NOW),
    NOW,
    "U1",
  );
  assert.ok(!quiet.summary.includes("<@U1>"));
  assert.ok(quiet.projects[0].startsWith("*beta*"));
  assert.ok(quiet.projects[1].includes("SrTechDeveloper 3h ago: “PR opened”"));
  const loud = formatDigest(
    buildRows([a], [], last, new Map([[a.id, 1]]), dir, NOW),
    NOW,
    "U1",
  );
  assert.ok(loud.summary.startsWith("<@U1>"));
});

test("needsAgent orders fresh breakage before old blocks", () => {
  const oldBlock = issue({
    status: "blocked",
    lastActivityAt: hoursAgo(24 * 90),
  });
  const newBlock = issue({ status: "blocked", lastActivityAt: hoursAgo(30) });
  const orphan = issue();
  const runs = [
    run(orphan, { status: "interrupted", errorCode: "orphaned_running_run" }),
  ];
  const rows = buildRows(
    [oldBlock, newBlock, orphan],
    runs,
    new Map(),
    new Map(),
    { projects: new Map(), agents: new Map() },
    NOW,
  );
  assert.deepEqual(
    needsAgent(rows).map((r) => r.issue.identifier),
    [orphan.identifier, newBlock.identifier, oldBlock.identifier],
  );
});
