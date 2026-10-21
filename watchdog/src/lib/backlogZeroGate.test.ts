import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, isParked, isUnowned, runGate, SAMPLE_SIZE } from "./backlogZeroGate.js";
import type { Issue, PaperclipGateApi } from "./backlogZeroGate.js";

const NOW = new Date("2026-10-21T13:00:00Z");
const PM = "74b1fe85-91bc-4e84-a89a-5a76eb9076fd";
const JAE = "D9cpomwhdAXklwXP3AbMc5SvlLrny0W5";

let seq = 0;
const issue = (over: Partial<Issue> = {}): Issue => {
  seq += 1;
  return { id: `id-${seq}`, identifier: `DAT-${seq}`, status: "todo", assigneeAgentId: null, assigneeUserId: null, ...over };
};

function fakeApi(issues: Issue[]): PaperclipGateApi & { fired: Record<string, unknown>[] } {
  const fired: Record<string, unknown>[] = [];
  return {
    fired,
    listOpenIssues: async () => issues,
    fireRoutine: async (payload) => {
      fired.push(payload);
    },
  };
}

test("isUnowned: open with no agent and no user", () => {
  for (const status of ["backlog", "todo", "blocked"] as const) assert.ok(isUnowned(issue({ status })));
});

test("isUnowned: a user-assigned task is owned (Jae's decision)", () => {
  assert.equal(isUnowned(issue({ assigneeUserId: JAE })), false);
});

test("isUnowned: closed or running tasks never count", () => {
  for (const status of ["in_progress", "in_review", "done", "cancelled"] as const) {
    assert.equal(isUnowned(issue({ status })), false);
  }
});

test("isParked: agent-assigned in backlog counts; in todo it does not", () => {
  assert.ok(isParked(issue({ status: "backlog", assigneeAgentId: PM })));
  assert.equal(isParked(issue({ status: "todo", assigneeAgentId: PM })), false);
  assert.equal(isParked(issue({ status: "backlog", assigneeUserId: JAE })), false);
});

test("decide: nothing unowned or parked means no fire", () => {
  const owned = [issue({ assigneeAgentId: PM }), issue({ assigneeUserId: JAE, status: "blocked" })];
  assert.deepEqual(decide(owned), { fire: false, unowned: 0, parked: 0 });
  assert.deepEqual(decide([]), { fire: false, unowned: 0, parked: 0 });
});

test("decide: counts both kinds and samples unowned first, capped", () => {
  const parked = issue({ status: "backlog", assigneeAgentId: PM });
  const unowned = Array.from({ length: SAMPLE_SIZE + 5 }, () => issue());
  const d = decide([parked, ...unowned]);
  assert.equal(d.fire, true);
  if (!d.fire) return;
  assert.equal(d.unowned, SAMPLE_SIZE + 5);
  assert.equal(d.parked, 1);
  assert.equal(d.sample.length, SAMPLE_SIZE);
  assert.equal(d.sample[0], unowned[0].identifier);
  assert.ok(!d.sample.includes(parked.identifier));
});

test("runGate: a clean backlog never fires the routine", async () => {
  const api = fakeApi([issue({ assigneeAgentId: PM })]);
  const result = await runGate(api, NOW);
  assert.equal(result.fire, false);
  assert.equal(api.fired.length, 0);
});

test("runGate: unowned work fires the routine once with the counts", async () => {
  const lone = issue();
  const api = fakeApi([lone, issue({ assigneeAgentId: PM })]);
  const result = await runGate(api, NOW);
  assert.equal(result.fire, true);
  assert.equal(api.fired.length, 1);
  assert.deepEqual(api.fired[0], {
    source: "trigger.dev paperclip-backlog-zero-gate",
    checkedAt: NOW.toISOString(),
    unowned: 1,
    parked: 0,
    sample: [lone.identifier],
  });
});

test("runGate: a failed listing propagates and fires nothing", async () => {
  const fired: unknown[] = [];
  const api: PaperclipGateApi = {
    listOpenIssues: async () => {
      throw new Error("Paperclip GET /issues failed: 502");
    },
    fireRoutine: async (p) => {
      fired.push(p);
    },
  };
  await assert.rejects(runGate(api, NOW), /502/);
  assert.equal(fired.length, 0);
});
