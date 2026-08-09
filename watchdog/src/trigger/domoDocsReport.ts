import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret, setSecret, cloneRepo, runUv } from "@datacrew/trigger-shared";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Replaces `datacrew`'s `generate-domo-recent-docs-report.yml` GitHub Action
 * (`Generate and Publish Domo Docs Canvas`, cron `0 8 * * *`) — see
 * `docs/watchdog-rework.md` and `docs/workflow-observability-standard.md` for
 * the conventions this follows, and ADR-001 for why this is `watchdog` and
 * not `executive-assistant`: the Slack Canvas is a maintained record no human
 * has to be watching for it to matter, same reasoning as `crew-rag-domo-scrape`.
 *
 * Deliberately a single `schedules.task`, not a parent that `triggerAndWait`s
 * child tasks — same Turnstile-gate-avoidance reasoning documented in
 * `crewRagDomoScrape.ts`. The orchestrator script this runs is inherently
 * linear (gate -> clone -> compute doc diff -> fetch forum posts -> render ->
 * push to Slack Canvas), so there's no benefit to composition here either.
 *
 * ## SHA-cache gate, and why it's *not* `actions/cache`
 *
 * The GitHub Action skips the whole run when `DomoApps/domo-documentation-hub`
 * hasn't moved since the last run, using `actions/cache` keyed on the latest
 * commit SHA. There is no equivalent in a Trigger.dev container: each run gets
 * a fresh filesystem, so a sentinel file on disk (what the Action, and the
 * bonker cron script issue #31 replaces, both do) is invisible to the next
 * run.
 *
 * The one thing every task in this repo already authenticates to and trusts
 * for *some* durable value is Infisical (see `packages/shared/src/infisical.ts`),
 * so that's what stores the last-processed SHA — `setSecret`/`getSecret`
 * against `SHA_CACHE_KEY` under this project's own `/datacrew` folder. It's
 * not a general-purpose KV store and isn't meant to become one; it's the
 * durable thing already wired up, reused for one small value. The alternative
 * considered was querying this task's own run history via the Trigger.dev
 * management API (`runs.list`) for the last successful run's output — rejected
 * as more moving parts (a second API, its own auth) for the same outcome.
 */

const SOURCE_REPO = "DomoApps/domo-documentation-hub";
const DATACREW_REPO_URL = "https://github.com/jaewilson07/datacrew.git";
const ORCHESTRATOR_RELATIVE_PATH =
  ".agents/runbooks/daily-slack-updates/update-canvas-domo-docs/scripts/main.py";

// Same folder the rest of this project's Infisical secrets live under
// (crewRagDomoScrape.ts's HECTOR_GH_PAT, repo-monitor's DATACREW_SLACK_BOT_TOKEN
// fallback), used here to also hold this task's small piece of durable state.
const SECRET_PATH = "/datacrew";
const SHA_CACHE_KEY = "DOMO_DOCS_LAST_PROCESSED_SHA";

const DEFAULT_DAYS = 30;
// Matches the `datacrew` repo variable `DATACREW_DOMO_DOCS_MIN_DATE` as of this
// migration (verified live via `gh variable list --repo jaewilson07/datacrew`).
// It's a floor date the maintainer moves occasionally to keep very old renamed/
// re-touched docs out of the digest, not something this task needs to compute —
// a manual trigger can still override it via the payload.
const DEFAULT_MIN_DATE = "2026-03-12";
// Same source: `gh variable list --repo jaewilson07/datacrew`.
const DEFAULT_CANVAS_CHANNEL_ID = "C0APDCU48GP";
const DEFAULT_CANVAS_ID = "F0AQ9FR8X6Z";

type DomoDocsReportPayload = {
  // `schedules.task` payloads carry a real `Date` when the scheduler invokes
  // them and a JSON string when a human triggers them from the dashboard or
  // API (same footgun `crewRagDomoScrape.ts`/`infraHealthReport.ts` document).
  timestamp: Date | string;
  timezone: string;
  /** Matches the old Action's `workflow_dispatch` input of the same name. */
  days?: number;
  /** Matches the old Action's `workflow_dispatch` input of the same name. */
  min_date?: string;
  /** Matches the old Action's `workflow_dispatch` input `force_run`: run even if the source repo is unchanged. */
  force_run?: boolean;
  /** Matches the old Action's `workflow_dispatch` input of the same name: generate the report but don't push to Slack. */
  skip_canvas?: boolean;
};

type DomoDocsReportOutcome = {
  status: "delivered" | "generated-only" | "skipped-unchanged";
  days: number;
  latestSha: string;
  previousSha: string | null;
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

async function fetchLatestSourceSha(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${SOURCE_REPO}/commits?per_page=1`, {
    headers: {
      "User-Agent": "datacrew-trigger-domo-docs-report/1.0",
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub API fetch failed for ${SOURCE_REPO}: ${res.status}`);
  }
  const data = (await res.json()) as Array<{ sha?: string }>;
  const sha = data[0]?.sha;
  if (!sha) {
    throw new Error(`GitHub API returned no commits for ${SOURCE_REPO}`);
  }
  return sha;
}

/** `null` means "no cache yet" (first run) rather than a real failure. */
async function readLastProcessedSha(): Promise<string | null> {
  try {
    return await getSecret(SHA_CACHE_KEY, { path: SECRET_PATH, recursive: false });
  } catch {
    return null;
  }
}

async function runDomoDocsReport(payload: DomoDocsReportPayload): Promise<DomoDocsReportOutcome> {
  const days = payload.days ?? DEFAULT_DAYS;
  const minDate = payload.min_date ?? DEFAULT_MIN_DATE;
  const timestampIso =
    payload.timestamp instanceof Date ? payload.timestamp.toISOString() : String(payload.timestamp);

  await safeAddTags(["domo-docs", "domo", "slack-canvas"]);
  logger.info("starting domo-docs-report", {
    days,
    minDate,
    timestamp: timestampIso,
    force: payload.force_run ?? false,
    skipCanvas: payload.skip_canvas ?? false,
  });

  const latestSha = await fetchLatestSourceSha();
  const previousSha = await readLastProcessedSha();

  if (!payload.force_run && previousSha !== null && previousSha === latestSha) {
    logger.info("completed domo-docs-report", {
      status: "skipped-unchanged",
      latestSha,
      days,
    });
    return { status: "skipped-unchanged", days, latestSha, previousSha };
  }

  // `datacrew` is jaewilson07-owned and private. HECTOR_GH_PAT (the
  // hector-dcs bot account, used by crewRagDomoScrape.ts for crew-rag-domo)
  // cannot see it — confirmed live, GET /repos/jaewilson07/datacrew with
  // HECTOR_GH_PAT returns 404, same failure mode already documented for
  // mdrag in crewRagDomoScrape.ts. JAEWILSON07_GH_PAT (authenticated as
  // jaewilson07 themself) returns 200. Root of the Infisical tree, not
  // /datacrew — this key isn't scoped to any single app.
  const jaewilson07Token = await getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false });

  // The orchestrator's own Slack posting needs a bot token with canvas
  // access to this specific canvas. The obvious candidate,
  // `DATACREW_SLACK_BOT_TOKEN` (a watchdog dashboard env var used by
  // infra-health-deliver/repo-monitor), is a *different* Slack workspace —
  // confirmed live: its token authenticates against a different team than
  // this canvas belongs to. The token that actually works is the one the
  // live GitHub Action already uses and was just observed succeeding
  // (`gh run view` on a 2026-08-08 run logged "Canvas updated: id=F0AQ9FR8X6Z"):
  // Infisical's plain `SLACK_BOT_TOKEN` at the tree root (not /datacrew).
  const slackBotToken = await getSecret("SLACK_BOT_TOKEN", { path: "/", recursive: false });

  const canvasChannelId = process.env.DATACREW_DOMO_DOCS_CANVAS_CHANNEL_ID || DEFAULT_CANVAS_CHANNEL_ID;
  const canvasId = process.env.DATACREW_DOMO_DOCS_CANVAS_ID || DEFAULT_CANVAS_ID;

  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "domo-docs-report-"));
  const dataCrewDir = path.join(scratchRoot, "datacrew");

  try {
    logger.info("cloning datacrew", { dataCrewDir });
    await cloneRepo(DATACREW_REPO_URL, dataCrewDir, jaewilson07Token);

    const scriptPath = path.join(dataCrewDir, ORCHESTRATOR_RELATIVE_PATH);
    const args = [
      "run",
      "--no-project",
      "--with",
      "slack-sdk",
      "--with",
      "aiohttp",
      "--with",
      "httpx",
      scriptPath,
      "--days",
      String(days),
      "--min-date",
      minDate,
      "--canvas-channel-id",
      canvasChannelId,
      "--canvas-id",
      canvasId,
      "--bot-token",
      slackBotToken,
      ...(payload.skip_canvas ? ["--skip-canvas"] : []),
    ];

    logger.info("running domo docs orchestrator", {
      scriptPath,
      days,
      minDate,
      canvasChannelId,
      canvasId,
      skipCanvas: payload.skip_canvas ?? false,
    });
    // The orchestrator internally clones DomoApps/domo-documentation-hub
    // itself (see generate_domo_recent_docs_report.py's ensure_clone) — this
    // task doesn't need to, it only needed the SHA for the gate above.
    const result = await runUv(dataCrewDir, args, { secrets: [slackBotToken] });
    logger.info("domo docs orchestrator finished", { stdoutTail: result.stdout.slice(-2000) });

    // Only advance the cache once the orchestrator actually completed —
    // a failed run should be retried against the same SHA next time, not
    // silently treated as "already processed".
    await setSecret(SHA_CACHE_KEY, latestSha, { path: SECRET_PATH });

    const status: DomoDocsReportOutcome["status"] = payload.skip_canvas ? "generated-only" : "delivered";
    logger.info("completed domo-docs-report", { status, latestSha, previousSha, days });
    return { status, days, latestSha, previousSha };
  } catch (error) {
    logger.error("failed domo-docs-report", {
      days,
      latestSha,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
}

export const domoDocsReport = schedules.task({
  id: "domo-docs-report",
  cron: {
    pattern: "0 8 * * *",
    environments: ["PRODUCTION"],
  },
  // Clones datacrew, `uv run --no-project`s an ad-hoc dependency set
  // (slack-sdk/aiohttp/httpx, no lockfile/venv reuse), which then does its
  // own internal git clone of domo-documentation-hub plus paginated forum
  // API calls and a Slack Canvas edit. Comparable in shape to
  // crew-rag-domo-scrape's 1800s budget; 900s is generous headroom given the
  // GitHub Action equivalent completes in well under a minute end-to-end.
  maxDuration: 900,
  run: async (payload: DomoDocsReportPayload) => runDomoDocsReport(payload),
});
