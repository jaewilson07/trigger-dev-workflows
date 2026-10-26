import { schedules, task, logger } from "@trigger.dev/sdk";

/**
 * Daily job search pipeline — scrape → dedup → sync → score/post to Slack.
 *
 * RUN AS FOUR PHASES (datacrew `POST /jobs/run/{phase}`), each its own
 * trigger.dev task so the dashboard shows which step is running, a slow or
 * failed step is visible on its own, and a retry re-runs one phase, not the
 * whole cycle. Raw scrape output is staged in the job-search DB between
 * `scrape` and `dedup`. The `job-search` schedule below is only the orchestrator.
 *
 * This is a THIN ORCHESTRATOR: the actual work (jobspy scraping, embedding
 * dedup, LLM scoring, Slack posting, Google Sheets sync) lives in the
 * Python `job-search` package at `datacrew/projects/job-search/`. This
 * task invokes it via an HTTP endpoint (FastAPI, served by `uvicorn`).
 *
 * WHY HTTP, not a TypeScript rewrite:
 *   The trigger.dev worker container is Alpine Linux with Node only — no
 *   Python, no uv, no jobspy. The pipeline is complex Python (jobspy scraper,
 *   sentence-transformers dedup, SQLite store, Slack poster, Google Sheets
 *   sync via cboti). Rewriting it in TypeScript would be a multi-week effort
 *   with no marginal benefit. The HTTP bridge is the same pattern used by
 *   mdrag primitives (lib/mdrag-primitives.ts) and Pattern Hunter
 *   (PATTERN_HUNTER_URL).
 *
 * NETWORKING:
 *   The Python API runs on the bonker HOST (not in Docker). The trigger.dev
 *   worker is in a container on the ai-network (172.19.0.0/16). To reach the
 *   host from Docker, use the bridge gateway IP (172.19.0.1) or run the API
 *   in its own container on ai-network (like pattern-hunter).
 *
 *   For local dev (`trigger dev`): http://localhost:8091 works.
 *   For deployed tasks: set JOB_SEARCH_API_URL=http://172.19.0.1:8091
 *   (or containerize the API and use container DNS).
 *
 *   THIS WAS NEVER ACTUALLY SET (diagnosed 2026-09-26): every deployed run
 *   hit the fallback `http://localhost:8091` — the task's OWN container,
 *   not bonker's host — so the health check always failed with "not
 *   reachable" regardless of whether the host service was up. Confirmed via
 *   `docker inspect trigger-supervisor-1`'s `DOCKER_RUNNER_NETWORKS` env
 *   (`webapp`, `ai-network` — task-run containers do attach to `ai-network`,
 *   whose gateway is `172.19.0.1`, matching this comment) and
 *   `GET /api/v1/projects/proj_noaaludkbpoorzosejyn/envvars/prod`, which had
 *   no `JOB_SEARCH_API_URL` entry. Set 2026-09-26 via that same API to
 *   `http://172.19.0.1:8091`.
 *
 *   SEPARATE, STILL-OPEN ISSUE: the `job-search-api` user systemd service on
 *   bonker is itself crash-looping (`systemctl --user status job-search-api`
 *   shows `activating (auto-restart)`, thousands of restarts) because
 *   `~/GitHub/homeserver/.env` fails to `source` — line 67 does not parse as
 *   valid bash (`<redacted>: unbound variable`). That file lives outside
 *   this repo and sits next to real secrets, so it needs a human to fix, not
 *   an agent. Until it's fixed, this task will keep failing even with the
 *   URL corrected above — now with a connection error instead of hitting
 *   the wrong host.
 *
 * ENV:
 *   JOB_SEARCH_API_URL — base URL of the Python API (default: localhost:8091,
 *   wrong for every deployed run — see above; set as a Trigger.dev project
 *   env var, not here, since it's host-topology config, not a secret)
 *   No secrets needed here — the Python API loads its own env from the
 *   homeserver .env file (Slack token, GDOC token, vLLM URL, etc.).
 */
const API_FALLBACK = "http://localhost:8091";

type PhaseResult = { status: string; counts?: Record<string, number>; errors?: string[] };

/** Call one phase on the job-search API; throw if the phase did not report ok. */
async function callPhase(
  phase: "scrape" | "dedup" | "sync" | "score",
  params: { source?: string; userId?: string } = {},
  budgetMs = 25 * 60 * 1000,
): Promise<PhaseResult> {
  const apiUrl = process.env.JOB_SEARCH_API_URL ?? API_FALLBACK;
  const qs = new URLSearchParams();
  if (params.source) qs.set("source", params.source);
  if (params.userId) qs.set("user_id", params.userId);
  const url = `${apiUrl}/jobs/run/${phase}${qs.size ? `?${qs}` : ""}`;

  logger.info(`job-search ${phase} starting`, { url });
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(budgetMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown error");
    throw new Error(`job-search ${phase} failed: ${res.status} — ${body}`);
  }
  const result = (await res.json()) as PhaseResult;
  logger.info(`job-search ${phase} finished`, { status: result.status, counts: result.counts });
  // The API answers 200 with status "error" when the phase subprocess fails
  // (datacrew#580). Throw so the run is marked failed and failure-alert-report
  // sees it, instead of a green run hiding a broken phase.
  if (result.status !== "ok") {
    throw new Error(
      `job-search ${phase} reported status "${result.status}": ${(result.errors ?? []).join(" | ") || "no error detail"}`,
    );
  }
  return result;
}

/** Boards to scrape, one parallel child run each. Override with JOB_SEARCH_SOURCES=a,b. */
const SOURCES = (process.env.JOB_SEARCH_SOURCES ?? "jobspy,ats")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const jobSearchScrape = task({
  id: "job-search-scrape",
  retry: { maxAttempts: 2 },
  run: async (payload: { source: string }) => callPhase("scrape", { source: payload.source }),
});

export const jobSearchDedup = task({
  id: "job-search-dedup",
  retry: { maxAttempts: 2 },
  run: async () => callPhase("dedup"),
});

export const jobSearchSync = task({
  id: "job-search-sync",
  retry: { maxAttempts: 1 },
  run: async () => callPhase("sync"),
});

export const jobSearchScore = task({
  id: "job-search-score",
  // Scoring posts to Slack; a blind retry could double-post.
  retry: { maxAttempts: 1 },
  run: async () => callPhase("score"),
});

export const jobSearch = schedules.task({
  id: "job-search",
  cron: {
    pattern: "0 7 * * *",
    timezone: "America/Denver",
  },
  ttl: "15m",
  queue: {
    concurrencyLimit: 1,
  },
  retry: { maxAttempts: 1 },
  run: async () => {
    const apiUrl = process.env.JOB_SEARCH_API_URL ?? API_FALLBACK;
    try {
      const healthRes = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);
    } catch (err) {
      logger.error("job-search API is not reachable", {
        apiUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Job-search API at ${apiUrl} is not reachable.`);
    }

    // 1. scrape — one child run per board, in parallel.
    const scraped = await jobSearchScrape
      .batchTriggerAndWait(SOURCES.map((source) => ({ payload: { source } })))
      .then((b) => b.runs);
    const scrapeCounts: Record<string, number> = {};
    for (const run of scraped) {
      if (run.ok) Object.assign(scrapeCounts, run.output.counts ?? {});
      else logger.error("scrape child failed", { error: String(run.error) });
    }
    // A single failed board must not sink the day: carry on with what staged.
    if (scraped.every((r) => !r.ok)) throw new Error("every scrape source failed");

    // 2-4. strictly sequential; each .unwrap() throws on child failure.
    const dedup = await jobSearchDedup.triggerAndWait().unwrap();
    await jobSearchSync.triggerAndWait().unwrap();
    const score = await jobSearchScore.triggerAndWait().unwrap();

    return { scrape: scrapeCounts, dedup: dedup.counts, score: score.counts };
  },
});
