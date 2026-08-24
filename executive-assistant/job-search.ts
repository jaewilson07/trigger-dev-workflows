import { schedules, logger } from "@trigger.dev/sdk";

/**
 * Daily job search pipeline — scrape → dedup → score → post to Slack.
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
 * ENV:
 *   JOB_SEARCH_API_URL — base URL of the Python API (default: localhost:8091)
 *   No secrets needed here — the Python API loads its own env from the
 *   homeserver .env file (Slack token, GDOC token, vLLM URL, etc.).
 */
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
  // Don't retry the whole pipeline — re-scraping and re-posting is wasteful.
  // If it fails, the next day's run will pick up the same jobs anyway.
  retry: { maxAttempts: 1 },
  run: async () => {
    const apiUrl = process.env.JOB_SEARCH_API_URL ?? "http://localhost:8091";

    logger.info("starting job-search", { apiUrl });

    // Health check first — fail fast if the API isn't running.
    try {
      const healthRes = await fetch(`${apiUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!healthRes.ok) {
        throw new Error(`Health check failed: ${healthRes.status}`);
      }
      logger.info("job-search API is healthy");
    } catch (err) {
      logger.error("job-search API is not reachable", {
        apiUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(
        `Job-search API at ${apiUrl} is not reachable. ` +
          "Start it with: cd datacrew/projects/job-search && uv run python -m job_search serve"
      );
    }

    // Run the full pipeline.
    const runRes = await fetch(`${apiUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(14 * 60 * 1000), // 14 min — pipeline can take 5-10 min
    });

    if (!runRes.ok) {
      const errorBody = await runRes.text().catch(() => "unknown error");
      logger.error("job-search pipeline failed", {
        status: runRes.status,
        error: errorBody,
      });
      throw new Error(`Pipeline run failed: ${runRes.status} — ${errorBody}`);
    }

    const result = (await runRes.json()) as {
      status: string;
      scraped?: number;
      after_dedup?: number;
      scored?: number;
      posted?: number;
      dropped?: number;
      errors?: string[];
    };

    logger.info("job-search completed", {
      status: result.status,
      scraped: result.scraped,
      afterDedup: result.after_dedup,
      scored: result.scored,
      posted: result.posted,
      dropped: result.dropped,
      errors: result.errors?.length ?? 0,
    });

    return result;
  },
});
