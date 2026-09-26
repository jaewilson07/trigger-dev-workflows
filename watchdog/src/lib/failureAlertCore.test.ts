import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessTaskRuns,
  buildFailureComment,
  buildFailureIssue,
  extractRunError,
  groupRunsByTask,
  isFailureStatus,
  isTerminalStatus,
  shouldThrottleComment,
  type RawRun,
} from "./failureAlertCore.js";
import { extractFingerprintMarker } from "./failureFingerprint.js";

function run(overrides: Partial<RawRun> & { taskIdentifier: string; status: string; createdAt: string }): RawRun {
  return {
    id: overrides.id ?? `run_${Math.random().toString(36).slice(2)}`,
    friendlyId: overrides.friendlyId ?? null,
    version: overrides.version ?? "20260926.1",
    error: overrides.error,
    ...overrides,
  };
}

test("isFailureStatus: success and non-terminal statuses are not failures", () => {
  assert.equal(isFailureStatus("COMPLETED"), false);
  assert.equal(isFailureStatus("COMPLETED_SUCCESSFULLY"), false);
  assert.equal(isFailureStatus("QUEUED"), false);
  assert.equal(isFailureStatus("EXECUTING"), false);
  assert.equal(isFailureStatus("CANCELED"), false);
  assert.equal(isFailureStatus("EXPIRED"), false);
});

test("isFailureStatus: known failure statuses are failures", () => {
  for (const s of ["COMPLETED_WITH_ERRORS", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "FAILED", "INTERRUPTED"]) {
    assert.equal(isFailureStatus(s), true, `expected ${s} to be a failure`);
  }
});

test("isFailureStatus: unrecognized status defaults to failure (fail loud, not silent)", () => {
  assert.equal(isFailureStatus("SOME_FUTURE_STATUS"), true);
});

test("isTerminalStatus: non-terminal statuses are excluded, everything else is terminal", () => {
  assert.equal(isTerminalStatus("QUEUED"), false);
  assert.equal(isTerminalStatus("EXECUTING"), false);
  assert.equal(isTerminalStatus("COMPLETED"), true);
  assert.equal(isTerminalStatus("CRASHED"), true);
});

test("groupRunsByTask: groups and sorts newest-first per task", () => {
  const runs = [
    run({ taskIdentifier: "a", status: "COMPLETED", createdAt: "2026-09-01T00:00:00Z" }),
    run({ taskIdentifier: "b", status: "CRASHED", createdAt: "2026-09-02T00:00:00Z" }),
    run({ taskIdentifier: "a", status: "CRASHED", createdAt: "2026-09-03T00:00:00Z" }),
  ];
  const byTask = groupRunsByTask(runs);
  assert.equal(byTask.size, 2);
  const a = byTask.get("a")!;
  assert.equal(a.length, 2);
  assert.equal(a[0]!.createdAt, "2026-09-03T00:00:00Z");
  assert.equal(a[1]!.createdAt, "2026-09-01T00:00:00Z");
});

test("assessTaskRuns: single failure is NOT enough (avoid one-off flakes)", () => {
  const runs = [
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-03T00:00:00Z" }),
    run({ taskIdentifier: "t", status: "COMPLETED", createdAt: "2026-09-02T00:00:00Z" }),
  ];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.shouldFile, false);
  assert.equal(result.consecutiveFailures, 1);
});

test("assessTaskRuns: 2 consecutive failures should file", () => {
  const runs = [
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-03T00:00:00Z" }),
    run({ taskIdentifier: "t", status: "TIMED_OUT", createdAt: "2026-09-02T00:00:00Z" }),
    run({ taskIdentifier: "t", status: "COMPLETED", createdAt: "2026-09-01T00:00:00Z" }),
  ];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.shouldFile, true);
  assert.equal(result.reason, "consecutive-failures");
  assert.equal(result.consecutiveFailures, 2);
  assert.equal(result.streak.length, 2);
});

test("assessTaskRuns: a success in between resets the streak", () => {
  const runs = [
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-04T00:00:00Z" }),
    run({ taskIdentifier: "t", status: "COMPLETED", createdAt: "2026-09-03T00:00:00Z" }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-02T00:00:00Z" }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z" }),
  ];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.consecutiveFailures, 1);
  assert.equal(result.shouldFile, false);
});

test("assessTaskRuns: never succeeded on current version files even with only 1 run", () => {
  const runs = [run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z", version: "v1" })];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.shouldFile, true);
  assert.equal(result.reason, "never-succeeded-on-version");
});

test("assessTaskRuns: succeeded once on an earlier version, now failing once on a NEW version -> files (never succeeded on THIS version)", () => {
  const runs = [
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-03T00:00:00Z", version: "v2" }),
    run({ taskIdentifier: "t", status: "COMPLETED", createdAt: "2026-09-02T00:00:00Z", version: "v1" }),
  ];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.shouldFile, true);
  assert.equal(result.reason, "never-succeeded-on-version");
});

test("assessTaskRuns: ignores non-terminal (in-flight) runs", () => {
  const runs = [
    run({ taskIdentifier: "t", status: "EXECUTING", createdAt: "2026-09-04T00:00:00Z" }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-03T00:00:00Z" }),
    run({ taskIdentifier: "t", status: "COMPLETED", createdAt: "2026-09-02T00:00:00Z" }),
  ];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.consecutiveFailures, 1);
  assert.equal(result.shouldFile, false);
});

test("assessTaskRuns: no runs at all -> never files", () => {
  const result = assessTaskRuns("t", []);
  assert.equal(result.shouldFile, false);
});

test("extractRunError: tolerates a string error", () => {
  const r = run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z", error: "boom" });
  assert.deepEqual(extractRunError(r), { name: "Error", message: "boom" });
});

test("extractRunError: tolerates a {name, message} object", () => {
  const r = run({
    taskIdentifier: "t",
    status: "CRASHED",
    createdAt: "2026-09-01T00:00:00Z",
    error: { name: "HTTPError", message: "502 Bad Gateway" },
  });
  assert.deepEqual(extractRunError(r), { name: "HTTPError", message: "502 Bad Gateway" });
});

test("extractRunError: tolerates a missing error", () => {
  const r = run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z" });
  const out = extractRunError(r);
  assert.equal(out.name, "UnknownError");
  assert.match(out.message, /CRASHED/);
});

test("buildFailureIssue: redacts secrets and embeds a fingerprint marker", () => {
  const runs = [
    run({
      taskIdentifier: "crew-rag-domo-scrape",
      status: "CRASHED",
      createdAt: "2026-09-03T00:00:00Z",
      friendlyId: "run_last",
      error: { name: "HTTPError", message: "auth failed with ghp_1234567890abcdef1234567890ABCDEF1234" },
    }),
    run({
      taskIdentifier: "crew-rag-domo-scrape",
      status: "CRASHED",
      createdAt: "2026-09-02T00:00:00Z",
      friendlyId: "run_first",
      error: { name: "HTTPError", message: "auth failed" },
    }),
  ];
  const assessment = assessTaskRuns("crew-rag-domo-scrape", runs);
  const issue = buildFailureIssue({ project: "watchdog", taskId: "crew-rag-domo-scrape", assessment });

  assert.ok(!issue.body.includes("ghp_1234567890"));
  assert.ok(issue.body.includes("hector-dcs/crew-rag-domo"));
  assert.ok(issue.body.includes("run_last"));
  assert.ok(issue.body.includes("run_first"));
  assert.deepEqual(issue.labels, ["ready-for-agent", "bug"]);
  assert.equal(extractFingerprintMarker(issue.body), issue.fingerprint);
});

test("buildFailureIssue: same underlying error, different run details -> same fingerprint", () => {
  const buildFor = (message: string, createdAt: string) => {
    const runs = [
      run({ taskIdentifier: "job-search", status: "CRASHED", createdAt, error: { name: "Error", message } }),
      run({
        taskIdentifier: "job-search",
        status: "CRASHED",
        createdAt: "2026-09-01T00:00:00Z",
        error: { name: "Error", message: "connect ECONNREFUSED 127.0.0.1" },
      }),
    ];
    const assessment = assessTaskRuns("job-search", runs);
    return buildFailureIssue({ project: "executive-assistant", taskId: "job-search", assessment });
  };

  const a = buildFor("connect ECONNREFUSED 127.0.0.1 after 3 tries", "2026-09-10T00:00:00Z");
  const b = buildFor("connect ECONNREFUSED 127.0.0.1 after 9 tries", "2026-09-20T00:00:00Z");
  assert.equal(a.fingerprint, b.fingerprint);
});

test("buildFailureComment: mentions the consecutive-failure count and redacts", () => {
  const runs = [
    run({
      taskIdentifier: "t",
      status: "CRASHED",
      createdAt: "2026-09-03T00:00:00Z",
      error: { name: "Error", message: "token=ghp_1234567890abcdef1234567890ABCDEF1234" },
    }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-02T00:00:00Z" }),
  ];
  const assessment = assessTaskRuns("t", runs);
  const comment = buildFailureComment({ project: "watchdog", taskId: "t", assessment });
  assert.match(comment, /2 consecutive failures/);
  assert.ok(!comment.includes("ghp_1234567890"));
});

test("shouldThrottleComment: no prior comment -> never throttled", () => {
  assert.equal(shouldThrottleComment(null), false);
});

test("shouldThrottleComment: commented 1h ago -> throttled", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const lastComment = new Date("2026-09-26T11:00:00Z");
  assert.equal(shouldThrottleComment(lastComment, now), true);
});

test("shouldThrottleComment: commented 25h ago -> not throttled", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const lastComment = new Date("2026-09-25T10:00:00Z");
  assert.equal(shouldThrottleComment(lastComment, now), false);
});
