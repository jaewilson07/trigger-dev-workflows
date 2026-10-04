import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { runFailureAlertSweep } from "../lib/failureAlertReporter.js";
import { fetchRunDetailForProject, fetchRunsForProject } from "../lib/failureAlertFetch.js";

/**
 * Failure alerting — jaewilson07/trigger-dev-workflows#206, item 1.
 *
 * On 2026-09-26 a manual audit of 14 days of `COMPLETED_WITH_ERRORS` runs
 * found eight independent tasks that had been failing daily (some for
 * weeks) with no alert ever firing — every one of them built, deployed, and
 * scheduled successfully, so nothing short of reading the database directly
 * would have caught them. This task closes that gap: every 30 minutes, it
 * queries the Trigger.dev management API (same endpoint
 * `scripts/trigger-deadman.mjs` already uses) for runs across all three
 * projects it watches (`../lib/failureRepoMap.ts`'s `MONITORED_PROJECTS`),
 * and files (or comments on) a GitHub issue for any task with >=2
 * consecutive failures, or that has >=2 terminal runs on its current deploy
 * version and has never succeeded on any of them (a single failure — the
 * only terminal run so far on a fresh deploy — is never enough on its own;
 * jaewilson07/trigger-dev-workflows#219-228 was this exact bug on the first
 * live run). When a task's newest run instead succeeds, any open issue it
 * filed gets a "recovered" comment and is closed. For the newest failing run
 * of a task about to be filed/commented, this also fetches that run's own
 * detail (`GET /api/v3/runs/{runId}`, via `fetchRunDetailForProject`) for its
 * real `error` — the list endpoint above never carries one, which is why
 * every issue before this change said the useless `UnknownError: run ended
 * with status FAILED`.
 *
 * Everything decision-y — classification, recovery, fingerprinting,
 * redaction, issue body, repo routing, the fallback-repo/throttle rules —
 * lives in `../lib/failureAlertCore.ts` (pure) and
 * `../lib/failureAlertReporter.ts` (IO). This file is a thin scheduled entry
 * point, same shape as every other watchdog report (`repoMonitorReport.ts`,
 * `infraHealthReport.ts`).
 *
 * Deliberately does NOT also post a Slack summary: watchdog has no single
 * shared Slack-post helper today (`repoMonitorReport.ts` and
 * `infraHealthReport.ts`/`infra-health-deliver.ts` each hand-roll their own
 * `resolveSlackToken`/`postToSlack` pair) — #206 itself says to skip the
 * Slack summary unless an existing helper makes it trivial, and duplicating
 * a third copy of that ~20-line pair is not "trivial". The filed GitHub
 * issue (labeled `ready-for-agent`) is the actual alert.
 *
 * State is entirely derivable from the Trigger.dev API + existing GitHub
 * issues (the hidden `<!-- trigger-failure:FP -->` and
 * `<!-- trigger-failure-task:TASKID -->` markers) — no local files, so this
 * is resumable/idempotent by construction: a container restart mid-sweep
 * just repeats the same fingerprint/task search on next run, and a
 * recovery-close that already happened is invisible to the next sweep's
 * `state:open` search.
 */

type SchedulePayload = {
  timestamp: Date;
  timezone: string;
};

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    logger.warn("failure-alert-report: skipping tags outside managed runtime", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `JAEWILSON07_GH_PAT` — the same GH token every other watchdog task that
 * needs to call the GitHub API already reads at runtime (grep
 * `watchdog/src/trigger` for `getSecret("JAEWILSON07_GH_PAT"`:
 * `crewRagDomoScrape.ts`, `domoCommunityJournal.ts`,
 * `slackCommunityJournal.ts`, every `vendor-docs/*DocsIngest.ts`). An
 * agent/bot-identity token, not a human PAT, and specifically NOT
 * `HECTOR_GH_PAT` (that one authenticates as the hector-dcs bot user and is
 * scoped for `crew-rag-domo`-style hector-dcs repos; using it here for a
 * general-purpose issue filer would be the wrong identity for every repo
 * except the one `crew-rag-domo-scrape` override already exists for). When
 * the owning repo is outside what this token can reach (e.g. an org where
 * it 403/404s), `runFailureAlertSweep`'s fallback files in
 * `jaewilson07/trigger-dev-workflows` instead and says so in the body.
 */
async function resolveGhToken(): Promise<string> {
  return getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false });
}

async function runFailureAlertReport(payload: SchedulePayload): Promise<{
  filedCount: number;
  errorCount: number;
}> {
  await safeAddTags(["failure-alert", "github", "observability"]);
  logger.info("starting failure-alert-report sweep", {
    timestamp: payload.timestamp.toISOString(),
    timezone: payload.timezone,
  });

  const result = await runFailureAlertSweep({
    resolveGhToken,
    fetchRuns: fetchRunsForProject,
    fetchRunDetail: fetchRunDetailForProject,
  });

  for (const filed of result.filed) {
    logger.info(`failure-alert-report: ${filed.action} issue for ${filed.project}/${filed.taskId}`, {
      repo: filed.repo,
      issueNumber: filed.issueNumber,
      action: filed.action,
    });
  }
  for (const error of result.errors) {
    logger.warn("failure-alert-report: sweep error", { error });
  }

  logger.info("completed failure-alert-report sweep", {
    filedCount: result.filed.length,
    errorCount: result.errors.length,
  });

  return { filedCount: result.filed.length, errorCount: result.errors.length };
}

export const failureAlertReport = schedules.task({
  id: "failure-alert-report",
  cron: {
    pattern: "*/30 * * * *",
    environments: ["PRODUCTION"],
  },
  run: async (payload: SchedulePayload) => runFailureAlertReport(payload),
});
