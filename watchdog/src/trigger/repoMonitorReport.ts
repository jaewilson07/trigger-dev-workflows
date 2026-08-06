import { schedules, batch, logger, tags } from "@trigger.dev/sdk";
import { checkRepoReleases } from "./tasks/check-repo-releases.js";
import { fetchInfisicalSecret } from "../lib/infisical.js";
import {
  buildSlackText,
  buildSlackBlocks,
} from "../lib/repo-monitor.js";
import type { RepoMonitorReport, RepoMonitorResult } from "../lib/repo-monitor.js";

/**
 * Repo monitor report — checks upstream GitHub repos for new releases and
 * notable commits, then posts a summary to Slack if there are updates.
 *
 * ## Composition
 *
 * Follows the watchdog pattern: schedule entry point → fan out check tasks
 * via `batch.triggerByTaskAndWait` → collect results → deliver to Slack.
 *
 * Currently monitors:
 * - `paperclipai/paperclip` — our agent orchestration platform
 *
 * Adding more repos is a one-line change to `REPO_TARGETS` below.
 *
 * ## Caching
 *
 * The last known release tag and commit SHA are stored in Trigger.dev task
 * metadata (via `tags.add` / `io.kv`). On the first run, everything is "new"
 * so we skip posting and just cache the current state. Subsequent runs only
 * post when there's something new.
 *
 * ## Schedule
 *
 * Wed/Fri at 9am MDT (15:00 UTC) — same cadence as the Letta release check.
 */

const DEFAULT_SLACK_CHANNEL = "C0AV0QJ0YMB"; // #datacrew-ai channel

// ---------------------------------------------------------------------------
// Repo targets — extend here to monitor more repos
// ---------------------------------------------------------------------------

const REPO_TARGETS = [
  {
    repo: "paperclipai/paperclip",
    lastKnownTag: "v2026.722.0", // initialized to current latest as of 2026-08-06
    lastKnownSha: null as string | null,
  },
];

// ---------------------------------------------------------------------------
// Schedule payload
// ---------------------------------------------------------------------------

type SchedulePayload = {
  timestamp: Date;
  timezone: string;
};

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    console.warn(
      "Skipping Trigger.dev tags outside managed runtime:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ---------------------------------------------------------------------------
// Slack delivery
// ---------------------------------------------------------------------------

async function resolveSlackToken(): Promise<string | null> {
  const fromEnv = process.env.DATACREW_SLACK_BOT_TOKEN;
  if (fromEnv) return fromEnv;

  try {
    return await fetchInfisicalSecret("DATACREW_SLACK_BOT_TOKEN");
  } catch (error) {
    logger.warn("repo-monitor: Infisical fallback failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function postToSlack(text: string, blocks: unknown[]): Promise<void> {
  const token = await resolveSlackToken();
  if (!token) {
    logger.warn("repo-monitor: no Slack token, skipping delivery");
    return;
  }

  const channel = process.env.REPO_MONITOR_SLACK_CHANNEL_ID || DEFAULT_SLACK_CHANNEL;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, blocks }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Slack post failed: ${res.status} ${data.error ?? "unknown_error"}`);
  }

  logger.info("repo-monitor: posted to Slack", { channel });
}

// ---------------------------------------------------------------------------
// Main task
// ---------------------------------------------------------------------------

async function runRepoMonitorReport(payload: SchedulePayload): Promise<{
  status: "ok" | "skipped";
  report: RepoMonitorReport;
}> {
  await safeAddTags(["repo-monitor", "github", "paperclip"]);
  logger.info("Starting repo monitor report", {
    timestamp: payload.timestamp.toISOString(),
    timezone: payload.timezone,
  });

  // Fan out one check task per repo
  const batchEntries = REPO_TARGETS.map((target) => ({
    task: checkRepoReleases,
    payload: { target },
  }));

  const { runs } = await batch.triggerByTaskAndWait(batchEntries);

  const results: RepoMonitorResult[] = runs.map((run, i) => {
    if (run.ok) {
      return run.output;
    }
    // A failed check is a reported check — don't crash the whole report
    const target = REPO_TARGETS[i];
    const errorMsg = run.error instanceof Error ? run.error.message : String(run.error);
    logger.warn("repo-monitor: check failed", {
      repo: target.repo,
      error: errorMsg,
    });
    return {
      repo: target.repo,
      latestRelease: null,
      recentCommits: [],
      hasNewRelease: false,
      newCommits: [],
    };
  });

  const hasUpdates = results.some(
    (r) => r.hasNewRelease || r.newCommits.length > 0
  );

  const report: RepoMonitorReport = {
    date: payload.timestamp.toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    results,
    hasUpdates,
  };

  if (!hasUpdates) {
    logger.info("repo-monitor: no updates, skipping Slack delivery");
    return { status: "skipped", report };
  }

  const text = buildSlackText(report);
  const blocks = buildSlackBlocks(report);
  await postToSlack(text, blocks);

  return { status: "ok", report };
}

export const repoMonitorReport = schedules.task({
  id: "repo-monitor-report",
  cron: {
    pattern: "0 15 * * 3,5", // Wed/Fri at 15:00 UTC = 9am MDT
    environments: ["PRODUCTION"],
  },
  run: async (payload: SchedulePayload) => runRepoMonitorReport(payload),
});
