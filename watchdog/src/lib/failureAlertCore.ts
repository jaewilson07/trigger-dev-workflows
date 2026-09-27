/**
 * Pure classification + issue-content logic for the failure-alert watchdog
 * task (jaewilson07/trigger-dev-workflows#206). No network, no fs, no
 * Trigger.dev SDK import — everything here takes plain data in and returns
 * plain data out, so it's what `failureAlertCore.test.ts` drives directly.
 * `failureAlertReporter.ts` is the thin IO shell around this.
 */

import { getOwningRepo } from "./failureRepoMap.js";
import { getTaskSourcePath } from "./taskSourceMap.js";
import { redactSecrets } from "./redactSecrets.js";
import { buildFailureFingerprint, buildFingerprintMarker, buildTaskMarker } from "./failureFingerprint.js";

/** One run, as read off `/api/v1/runs`. Only the fields this module reads —
 * the real payload has many more. */
export type RawRun = {
  id: string;
  friendlyId?: string | null;
  taskIdentifier: string;
  status: string;
  createdAt: string;
  version?: string | null;
  error?: unknown;
};

/** Statuses that mean "this run finished cleanly." */
const SUCCESS_STATUSES = new Set(["COMPLETED", "COMPLETED_SUCCESSFULLY"]);

/** Statuses that mean "still in flight" — not yet a verdict either way. */
const NON_TERMINAL_STATUSES = new Set([
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "WAITING_TO_RESUME",
  "WAITING_FOR_DEPLOY",
  "DELAYED",
  "PAUSED",
  "RETRYING_AFTER_FAILURE",
]);

/** Terminal, but not a "failure" worth an issue — a deliberate cancel or an
 * expiry (e.g. a delayed run whose TTL passed before it started). */
const IGNORED_TERMINAL_STATUSES = new Set(["CANCELED", "EXPIRED"]);

/**
 * Everything else terminal — `COMPLETED_WITH_ERRORS`, `CRASHED`,
 * `SYSTEM_FAILURE`, `TIMED_OUT`, `FAILED`, `INTERRUPTED`, and any future or
 * unrecognized terminal-shaped status — counts as a failure. Treating an
 * unrecognized status as a failure (rather than silently skipping it) is
 * deliberate: a status this code doesn't know about yet should surface, not
 * vanish.
 */
export function isFailureStatus(status: string): boolean {
  if (SUCCESS_STATUSES.has(status)) return false;
  if (NON_TERMINAL_STATUSES.has(status)) return false;
  if (IGNORED_TERMINAL_STATUSES.has(status)) return false;
  return true;
}

/** True for the two statuses that mean "this run finished cleanly" —
 * deliberately narrower than "not a failure" (which would also admit
 * CANCELED/EXPIRED): recovery only fires on an actual success. */
export function isSuccessStatus(status: string): boolean {
  return SUCCESS_STATUSES.has(status);
}

export function isTerminalStatus(status: string): boolean {
  return !NON_TERMINAL_STATUSES.has(status);
}

/** Group runs by task id, each group sorted newest-first. */
export function groupRunsByTask(runs: RawRun[]): Map<string, RawRun[]> {
  const byTask = new Map<string, RawRun[]>();
  for (const r of runs) {
    const arr = byTask.get(r.taskIdentifier);
    if (arr) arr.push(r);
    else byTask.set(r.taskIdentifier, [r]);
  }
  for (const arr of byTask.values()) {
    arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  return byTask;
}

export type FailureReason = "consecutive-failures" | "never-succeeded-on-version";

export type TaskAssessment = {
  taskId: string;
  shouldFile: boolean;
  reason: FailureReason | null;
  consecutiveFailures: number;
  /** The leading run(s) that are failures, newest first. Empty when the most
   * recent terminal run succeeded. */
  streak: RawRun[];
  latestVersion: string | null;
  /** The newest terminal run, but ONLY when it actually succeeded — the
   * signal `runFailureAlertSweep` uses to comment-and-close any open issue
   * this task filed. `null` whenever there's nothing to recover from: no
   * terminal runs yet, the newest terminal run failed, or it was
   * canceled/expired (terminal but not a success). */
  recoveredRun: RawRun | null;
};

/**
 * Decide whether `taskId`'s runs (newest first, already scoped to one task)
 * warrant filing/commenting: >=2 consecutive failures, OR every run on the
 * current deploy version failed (never succeeded on it) — #206's own
 * wording, meant to catch both "it broke and stayed broken" and "it never
 * worked since the last deploy" while ignoring a single one-off flake.
 */
export function assessTaskRuns(taskId: string, runsNewestFirst: RawRun[]): TaskAssessment {
  const terminal = runsNewestFirst.filter((r) => isTerminalStatus(r.status));
  if (terminal.length === 0) {
    return {
      taskId,
      shouldFile: false,
      reason: null,
      consecutiveFailures: 0,
      streak: [],
      latestVersion: null,
      recoveredRun: null,
    };
  }

  const latestVersion = terminal[0]!.version ?? null;
  const recoveredRun = isSuccessStatus(terminal[0]!.status) ? terminal[0]! : null;

  const streak: RawRun[] = [];
  for (const r of terminal) {
    if (isFailureStatus(r.status)) streak.push(r);
    else break;
  }
  const consecutiveFailures = streak.length;

  const onLatestVersion = latestVersion == null ? [] : terminal.filter((r) => r.version === latestVersion);
  // Requires >=2 terminal runs on the latest version -- a single failure
  // right after a deploy (the only terminal run so far on that version) must
  // never file on its own (jaewilson07/trigger-dev-workflows#219-228 audit:
  // one failure was qualifying and filing "1 consecutive failures").
  const neverSucceededOnVersion = onLatestVersion.length >= 2 && onLatestVersion.every((r) => isFailureStatus(r.status));

  const reason: FailureReason | null =
    consecutiveFailures >= 2 ? "consecutive-failures" : neverSucceededOnVersion ? "never-succeeded-on-version" : null;

  return {
    taskId,
    shouldFile: reason !== null,
    reason,
    consecutiveFailures,
    streak,
    latestVersion,
    recoveredRun,
  };
}

export type NormalizedError = { name: string; message: string };

/**
 * Pull a name/message pair out of whatever shape `run.error` turns out to
 * be — the exact schema of `/api/v1/runs`' `error` field is not verified
 * live in this change (see PR description); tolerate string, `{message}`,
 * `{name, message}`, or absent, rather than assuming one shape and crashing
 * on the others.
 */
export function extractRunError(run: RawRun): NormalizedError {
  const err = run.error;
  if (err == null) return { name: "UnknownError", message: `run ended with status ${run.status}` };
  if (typeof err === "string") return { name: "Error", message: err };
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : "Error";
    const message =
      typeof obj.message === "string"
        ? obj.message
        : (() => {
            try {
              return JSON.stringify(obj);
            } catch {
              return String(obj);
            }
          })();
    return { name, message };
  }
  return { name: "Error", message: String(err) };
}

export type FailureContext = {
  project: string;
  taskId: string;
  assessment: TaskAssessment;
};

export type BuiltFailureIssue = {
  fingerprint: string;
  title: string;
  body: string;
  labels: string[];
};

const DASHBOARD_BASE_URL = "https://triggers.datacrew.space";
const DEFAULT_ISSUE_REPO_NOTE = "jaewilson07/trigger-dev-workflows";

function runLink(run: RawRun): string {
  const friendly = run.friendlyId ?? run.id;
  // NOTE: the exact per-run deep-link route on the self-hosted dashboard is
  // not verified in this change (no live access to confirm the org/env
  // slugs a Remix route like `orgs/$orgParam/projects/$projectParam/runs/$runParam`
  // would need) — linking the base dashboard plus the searchable friendlyId
  // is the honest thing to ship rather than a guessed URL that might 404.
  return `\`${friendly}\` (search it in the [dashboard](${DASHBOARD_BASE_URL}))`;
}

/**
 * Build the title/body/labels for a failure issue (or the comment body for
 * an already-open one — same content either way; `reportFailure` in
 * `failureAlertReporter.ts` decides which to send). The redacted error and
 * the hidden `<!-- trigger-failure:FP -->` marker are both embedded in the
 * BODY (not the title), so a search for the marker survives whatever title
 * a human or agent later edits.
 */
export function buildFailureIssue(ctx: FailureContext): BuiltFailureIssue {
  const { project, taskId, assessment } = ctx;
  const latestRun = assessment.streak[0];
  const firstRun = assessment.streak[assessment.streak.length - 1];
  if (!latestRun || !firstRun) {
    throw new Error(`buildFailureIssue: assessment for ${project}/${taskId} has an empty failure streak`);
  }

  const rawError = extractRunError(latestRun);
  const redactedMessage = redactSecrets(rawError.message);
  const fingerprint = buildFailureFingerprint(taskId, rawError.name, redactedMessage);

  const owningRepo = getOwningRepo(project, taskId);
  const sourcePath = getTaskSourcePath(project, taskId);

  // Never phrase this as "N consecutive failures" for the
  // never-succeeded-on-version reason -- that reason can fire with
  // consecutiveFailures as low as 1 (see the sandwiched-version test case in
  // failureAlertCore.test.ts), and #226/#227 shipped exactly that lie ("1
  // consecutive failures") on the first live run.
  const reasonLine =
    assessment.reason === "never-succeeded-on-version"
      ? `Has never succeeded on version \`${assessment.latestVersion ?? "unknown"}\`.`
      : `${assessment.consecutiveFailures} consecutive failures.`;

  const title =
    assessment.reason === "never-succeeded-on-version"
      ? `${taskId}: never succeeded on version ${assessment.latestVersion ?? "unknown"} (${project})`
      : `${taskId}: ${assessment.consecutiveFailures} consecutive failures (${project})`;

  const stackExcerpt = (() => {
    const err = latestRun.error;
    if (err && typeof err === "object" && typeof (err as Record<string, unknown>).stackTrace === "string") {
      const redacted = redactSecrets((err as Record<string, string>).stackTrace);
      return redacted.split("\n").slice(0, 15).join("\n");
    }
    return null;
  })();

  const bodyLines = [
    `**Task:** \`${taskId}\``,
    `**Project:** ${project}`,
    `**Owning repo:** ${owningRepo}`,
    `**Source:** ${sourcePath ? `\`${sourcePath}\`` : "not indexed — search the project for this task id"}`,
    "",
    reasonLine,
    `**First failing run (this streak):** ${runLink(firstRun)} at ${firstRun.createdAt}`,
    `**Last failing run:** ${runLink(latestRun)} at ${latestRun.createdAt}`,
    "",
    `**Error (${rawError.name}):**`,
    "```",
    redactedMessage,
    "```",
  ];

  if (stackExcerpt) {
    bodyLines.push("", "**Stack excerpt:**", "```", stackExcerpt, "```");
  }

  bodyLines.push(
    "",
    "**How to reproduce:**",
    sourcePath
      ? `Read \`${sourcePath}\` in this repo (${DEFAULT_ISSUE_REPO_NOTE}), then trigger \`${taskId}\` from the ` +
          `[dashboard](${DASHBOARD_BASE_URL})'s Test tab with an empty/representative payload and watch the logs.`
      : `Search \`${project}/\` for a task with id \`${taskId}\`, then trigger it from the ` +
          `[dashboard](${DASHBOARD_BASE_URL})'s Test tab and watch the logs.`,
    "",
    `Filed automatically by \`watchdog/src/trigger/failureAlertReport.ts\` — jaewilson07/trigger-dev-workflows#206.`,
    "",
    buildFingerprintMarker(fingerprint),
    buildTaskMarker(taskId)
  );

  return {
    fingerprint,
    title,
    body: bodyLines.join("\n"),
    labels: ["ready-for-agent", "bug"],
  };
}

export function buildFailureComment(ctx: FailureContext): string {
  const { taskId, assessment } = ctx;
  const latestRun = assessment.streak[0];
  if (!latestRun) {
    throw new Error(`buildFailureComment: assessment for ${taskId} has an empty failure streak`);
  }
  const rawError = extractRunError(latestRun);
  const redactedMessage = redactSecrets(rawError.message);

  const headline =
    assessment.reason === "never-succeeded-on-version"
      ? `Another failure on \`${taskId}\`: has never succeeded on version \`${assessment.latestVersion ?? "unknown"}\`.`
      : `Another failure on \`${taskId}\`: ${assessment.consecutiveFailures} consecutive failures.`;

  return [
    headline,
    "",
    `**Last failing run:** ${runLink(latestRun)} at ${latestRun.createdAt}`,
    "",
    `**Error (${rawError.name}):**`,
    "```",
    redactedMessage,
    "```",
  ].join("\n");
}

/** Body prefix used when a repo fell back to the default because the
 * intended owning repo rejected the create/search with 403/404. */
export function buildFallbackNote(intendedRepo: string): string {
  return (
    `_Filed here instead of \`${intendedRepo}\` — that repo rejected the ` +
    `GitHub API call (403/404). The task most likely still belongs there._\n\n`
  );
}

/** Throttle: at most one comment per issue per 24h. */
export function shouldThrottleComment(lastCommentAt: Date | null, now: Date = new Date()): boolean {
  if (!lastCommentAt) return false;
  const hoursSince = (now.getTime() - lastCommentAt.getTime()) / 3_600_000;
  return hoursSince < 24;
}

/**
 * Comment posted on an open issue once its task's newest run has succeeded
 * (jaewilson07/trigger-dev-workflows#206 follow-up: "no close on recovery").
 * `runFailureAlertSweep` posts this then closes the issue (`state_reason:
 * "completed"`) for every open issue `findOpenByTask` finds for the task.
 */
export function buildRecoveryComment(recoveredRun: RawRun): string {
  const friendly = recoveredRun.friendlyId ?? recoveredRun.id;
  return `recovered: run ${friendly} succeeded at ${recoveredRun.createdAt}`;
}

/**
 * Result of attempting to fetch a run's full detail (`GET
 * /api/v3/runs/{runId}`) — the list endpoint (`/api/v1/runs`, what
 * `assessTaskRuns` is fed from) does not carry `error`, which is why every
 * issue before this change said the useless `UnknownError: run ended with
 * status FAILED`. IO-free by design: the fetch itself happens in
 * `failureAlertFetch.ts`/`failureAlertReporter.ts`; this is just the shape
 * `applyFetchedRunError` consumes.
 */
export type RunErrorFetchResult = { ok: true; error: unknown } | { ok: false; reason: string };

/**
 * Merge a fetched run-detail error onto the newest failing run in
 * `assessment`'s streak — `buildFailureIssue`/`buildFailureComment` both read
 * `streak[0]`'s `.error` (via `extractRunError`), so replacing it here, once,
 * before either is called, is how the real error reaches both a newly
 * created issue AND a comment on a repeat failure. A failed fetch keeps the
 * existing fallback text but says why the real error is missing, rather than
 * silently reverting to "run ended with status FAILED" as if nothing was
 * tried. A no-op when there's nothing to enrich (empty streak — recovery
 * sweeps don't call this).
 */
export function applyFetchedRunError(assessment: TaskAssessment, result: RunErrorFetchResult): TaskAssessment {
  const latestRun = assessment.streak[0];
  if (!latestRun) return assessment;

  const enrichedRun: RawRun = result.ok
    ? result.error == null
      ? latestRun
      : { ...latestRun, error: result.error }
    : {
        ...latestRun,
        error: {
          name: "UnknownError",
          message: `run ended with status ${latestRun.status}; error detail unavailable: ${result.reason}`,
        },
      };

  return { ...assessment, streak: [enrichedRun, ...assessment.streak.slice(1)] };
}
