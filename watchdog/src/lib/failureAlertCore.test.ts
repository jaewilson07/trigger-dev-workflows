import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFetchedRunError,
  assessTaskRuns,
  buildFailureComment,
  buildFailureIssue,
  buildRecoveryComment,
  extractRunError,
  groupRunsByTask,
  isFailureStatus,
  isSuccessStatus,
  isTerminalStatus,
  shouldThrottleComment,
  type RawRun,
} from "./failureAlertCore.js";
import { extractFingerprintMarker, extractTaskMarker } from "./failureFingerprint.js";

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

test("assessTaskRuns: a single failure is NEVER enough to file, even as the only run on a brand-new version (bug: right after a deploy, one failure used to qualify)", () => {
  const runs = [run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z", version: "v1" })];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.shouldFile, false);
  assert.equal(result.reason, null);
});

test("assessTaskRuns: succeeded once on an earlier version, now failing ONCE on a new version -> still does not file (one failure right after a deploy is not enough)", () => {
  const runs = [
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-03T00:00:00Z", version: "v2" }),
    run({ taskIdentifier: "t", status: "COMPLETED", createdAt: "2026-09-02T00:00:00Z", version: "v1" }),
  ];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.shouldFile, false);
  assert.equal(result.reason, null);
});

test("assessTaskRuns: never-succeeded-on-version requires >=2 terminal runs on that version, both failing", () => {
  // Newest-first: two failures on the new version (v2), with an older-version
  // SUCCESS sandwiched between them so the plain consecutive-failure streak
  // (which counts across versions) is only 1 -- isolating this reason from
  // "consecutive-failures".
  const runs = [
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-04T00:00:00Z", version: "v2" }),
    run({ taskIdentifier: "t", status: "COMPLETED", createdAt: "2026-09-03T00:00:00Z", version: "v1" }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-02T00:00:00Z", version: "v2" }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z", version: "v1" }),
  ];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.shouldFile, true);
  assert.equal(result.reason, "never-succeeded-on-version");
  assert.equal(result.consecutiveFailures, 1);
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

test("isSuccessStatus: only the two success statuses are success", () => {
  assert.equal(isSuccessStatus("COMPLETED"), true);
  assert.equal(isSuccessStatus("COMPLETED_SUCCESSFULLY"), true);
  assert.equal(isSuccessStatus("CANCELED"), false);
  assert.equal(isSuccessStatus("CRASHED"), false);
});

test("assessTaskRuns: newest terminal run succeeded -> recoveredRun is that run", () => {
  const runs = [
    run({ taskIdentifier: "t", status: "COMPLETED", createdAt: "2026-09-03T00:00:00Z", friendlyId: "run_ok" }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-02T00:00:00Z" }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z" }),
  ];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.shouldFile, false);
  assert.ok(result.recoveredRun);
  assert.equal(result.recoveredRun!.friendlyId, "run_ok");
});

test("assessTaskRuns: newest terminal run failed -> recoveredRun is null", () => {
  const runs = [run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z" })];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.recoveredRun, null);
});

test("assessTaskRuns: newest terminal run was canceled (not a success, not a failure) -> recoveredRun is null", () => {
  const runs = [run({ taskIdentifier: "t", status: "CANCELED", createdAt: "2026-09-01T00:00:00Z" })];
  const result = assessTaskRuns("t", runs);
  assert.equal(result.recoveredRun, null);
});

test("assessTaskRuns: no terminal runs at all -> recoveredRun is null", () => {
  const result = assessTaskRuns("t", []);
  assert.equal(result.recoveredRun, null);
});

test("buildRecoveryComment: says which run succeeded and when", () => {
  const recoveredRun = run({
    taskIdentifier: "t",
    status: "COMPLETED",
    createdAt: "2026-09-26T15:00:00.000Z",
    friendlyId: "run_cmuiZZZ",
  });
  const comment = buildRecoveryComment(recoveredRun);
  assert.equal(comment, "recovered: run run_cmuiZZZ succeeded at 2026-09-26T15:00:00.000Z");
});

test("buildRecoveryComment: falls back to id when friendlyId is absent", () => {
  const recoveredRun = run({
    taskIdentifier: "t",
    status: "COMPLETED",
    createdAt: "2026-09-26T15:00:00.000Z",
    id: "run_internal_id",
    friendlyId: null,
  });
  const comment = buildRecoveryComment(recoveredRun);
  assert.match(comment, /run run_internal_id succeeded/);
});

test("applyFetchedRunError: a successfully fetched error replaces the streak's newest run's error", () => {
  const runs = [
    run({
      taskIdentifier: "t",
      status: "CRASHED",
      createdAt: "2026-09-02T00:00:00Z",
      error: undefined,
    }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z" }),
  ];
  const assessment = assessTaskRuns("t", runs);
  const enriched = applyFetchedRunError(assessment, {
    ok: true,
    error: { name: "HTTPError", message: "the real underlying error" },
  });
  const rawError = extractRunError(enriched.streak[0]!);
  assert.deepEqual(rawError, { name: "HTTPError", message: "the real underlying error" });
});

test("applyFetchedRunError: a failed fetch keeps the fallback text but says retrieval failed", () => {
  const runs = [run({ taskIdentifier: "t", status: "FAILED", createdAt: "2026-09-01T00:00:00Z" })];
  // Force shouldFile via a second failing run so there's a real streak to enrich.
  const runs2 = [
    run({ taskIdentifier: "t", status: "FAILED", createdAt: "2026-09-02T00:00:00Z" }),
    ...runs,
  ];
  const assessment = assessTaskRuns("t", runs2);
  const enriched = applyFetchedRunError(assessment, { ok: false, reason: "GET failed with 500" });
  const rawError = extractRunError(enriched.streak[0]!);
  assert.match(rawError.message, /run ended with status FAILED/);
  assert.match(rawError.message, /error detail unavailable: GET failed with 500/);
});

test("applyFetchedRunError: an empty streak (nothing to enrich) is a no-op", () => {
  const assessment = assessTaskRuns("t", []);
  const enriched = applyFetchedRunError(assessment, { ok: true, error: { name: "E", message: "m" } });
  assert.deepEqual(enriched, assessment);
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

test("buildFailureIssue: never-succeeded-on-version title never says '<n> consecutive failures' (bug: #226/#227 said '1 consecutive failures')", () => {
  const runs = [
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-04T00:00:00Z", version: "v2" }),
    run({ taskIdentifier: "t", status: "COMPLETED", createdAt: "2026-09-03T00:00:00Z", version: "v1" }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-02T00:00:00Z", version: "v2" }),
    run({ taskIdentifier: "t", status: "CRASHED", createdAt: "2026-09-01T00:00:00Z", version: "v1" }),
  ];
  const assessment = assessTaskRuns("t", runs);
  assert.equal(assessment.reason, "never-succeeded-on-version"); // sanity: exercising the right branch
  const issue = buildFailureIssue({ project: "watchdog", taskId: "t", assessment });
  assert.ok(!/\bconsecutive failures\b/.test(issue.title), `title must not say "consecutive failures": ${issue.title}`);
  assert.match(issue.title, /never succeeded on version/);
  assert.match(issue.title, /v2/);
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
