import { schedules, logger } from "@trigger.dev/sdk";
import {
  upsertNotionPage,
  notionTokenFromEnv,
  extractNotionId,
} from "@datacrew/trigger-shared";

/**
 * Sync job-search pipeline results to a Notion database.
 *
 * Runs AFTER the daily job-search pipeline (7am Denver) — scrapes, scores,
 * and posts to Slack. This task reads the scored results and upserts them
 * to a Notion database so Jae can track applications, filter by score,
 * and manage the pipeline visually.
 *
 * DEDUP STRATEGY: upsertNotionPage keys on the page title
 * ("{title} @ {company}"), so re-running syncs the same jobs without
 * creating duplicates. Score/status updates overwrite the existing row.
 *
 * ENV:
 *   JOB_SEARCH_API_URL — base URL of the Python API (same as job-search.ts).
 *     Required: there is no default, because localhost inside the worker
 *     container never reaches the API.
 *   NOTION_TOKEN or NOTION_API_KEY — Notion integration token
 *   JOB_SEARCH_NOTION_DB — Notion database ID or URL for the job tracker
 *
 * The Notion database needs these properties (auto-created 2026-10-12):
 *   Name (title), Company (rich_text), Location (rich_text), URL (url),
 *   Salary (rich_text), Source (select), Fit Score (number),
 *   Status (select), Date Found (date), Tags (multi_select),
 *   Description (rich_text)
 */

export class JobSearchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobSearchConfigError";
  }
}

const DEFAULT_DB = "3f70f441731280d6b76cc849fb682034";

type JobForSync = {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  salary: string;
  description: string;
  source: string;
  score: number | null;
  is_remote: boolean;
  is_contract: boolean;
  fetched_at: string;
};

function jobPageTitle(job: JobForSync): string {
  return `${job.title} @ ${job.company}`;
}

function jobToMarkdown(job: JobForSync): string {
  const lines: string[] = [];
  lines.push(`## ${job.title}`);
  lines.push("");
  lines.push(`**Company:** ${job.company}`);
  if (job.location) lines.push(`**Location:** ${job.location}`);
  if (job.salary) lines.push(`**Salary:** ${job.salary}`);
  if (job.is_remote) lines.push(`**Remote:** Yes`);
  if (job.is_contract) lines.push(`**Contract:** Yes`);
  if (job.score !== null) lines.push(`**Fit Score:** ${job.score.toFixed(2)}`);
  if (job.url) lines.push(`**Apply:** ${job.url}`);
  lines.push("");
  if (job.description) {
    lines.push("### Description");
    lines.push("");
    lines.push(job.description);
  }
  return lines.join("\n");
}

function jobToProperties(job: JobForSync): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  if (job.company) {
    props["Company"] = {
      rich_text: [{ type: "text", text: { content: job.company } }],
    };
  }
  if (job.location) {
    props["Location"] = {
      rich_text: [{ type: "text", text: { content: job.location } }],
    };
  }
  if (job.url) {
    props["URL"] = { url: job.url };
  }
  if (job.salary) {
    props["Salary"] = {
      rich_text: [{ type: "text", text: { content: job.salary } }],
    };
  }
  if (job.source) {
    // Map internal source names to the select options in the DB
    const sourceMap: Record<string, string> = {
      domo_community: "domo",
      jobspy: "jobspy",
      adzuna: "jobspy",
      ats: "jobspy",
    };
    props["Source"] = {
      select: { name: sourceMap[job.source] ?? job.source },
    };
  }
  if (job.score !== null) {
    props["Fit Score"] = { number: Math.round(job.score * 100) / 100 };
  }
  if (job.fetched_at) {
    // fetched_at is "YYYY-MM-DD HH:MM:SS" — Notion wants ISO date
    props["Date Found"] = { date: { start: job.fetched_at.split(" ")[0] } };
  }

  const tags: Array<{ name: string }> = [];
  const descLower = (job.description + " " + job.title).toLowerCase();
  if (descLower.includes("domo")) tags.push({ name: "domo" });
  if (descLower.includes("analytics") || descLower.includes("data"))
    tags.push({ name: "analytics" });
  if (descLower.includes("ai") || descLower.includes("machine learning") || descLower.includes("llm"))
    tags.push({ name: "ai" });
  if (descLower.includes("engineer") || descLower.includes("pipeline") || descLower.includes("etl"))
    tags.push({ name: "data-engineering" });
  if (job.is_remote) tags.push({ name: "remote" });
  if (tags.length > 0) {
    props["Tags"] = { multi_select: tags };
  }

  // Default status for synced jobs
  props["Status"] = { select: { name: "New" } };

  if (job.description) {
    props["Description"] = {
      rich_text: [{ type: "text", text: { content: job.description.slice(0, 2000) } }],
    };
  }

  return props;
}

export const jobSearchNotion = schedules.task({
  id: "job-search-notion",
  cron: {
    // 30 min after the pipeline runs (7am Denver) — enough time to finish
    pattern: "30 7 * * *",
    timezone: "America/Denver",
  },
  ttl: "10m",
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },
  run: async () => {
    logger.info("starting job-search Notion sync");
    const apiUrl = process.env.JOB_SEARCH_API_URL;
    if (!apiUrl) throw new JobSearchConfigError("JOB_SEARCH_API_URL is not set");
    const token = notionTokenFromEnv();
    const dbId = extractNotionId(
      process.env.JOB_SEARCH_NOTION_DB ?? DEFAULT_DB
    );

    if (!token) {
      logger.warn("No Notion token configured — skipping sync");
      return { status: "skipped", reason: "no NOTION_TOKEN" };
    }

    // Fetch jobs from the pipeline API
    logger.info("Fetching jobs from pipeline API", { apiUrl });
    const res = await fetch(`${apiUrl}/jobs/list?days=30&limit=200`, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "unknown");
      throw new Error(`Failed to fetch jobs: ${res.status} — ${body}`);
    }

    const data = (await res.json()) as { jobs: JobForSync[]; count: number };
    logger.info(`Fetched ${data.count} jobs from pipeline`);

    if (data.count === 0) {
      return { status: "ok", synced: 0, created: 0, updated: 0 };
    }

    // Upsert each job to Notion
    let created = 0;
    let updated = 0;
    let errors = 0;

    for (const job of data.jobs) {
      try {
        const result = await upsertNotionPage({
          token,
          databaseId: dbId,
          title: jobPageTitle(job),
          markdown: jobToMarkdown(job),
          mode: "replace",
          properties: jobToProperties(job),
        });

        if (result.created) created++;
        else updated++;
      } catch (err) {
        errors++;
        logger.error(`Failed to sync job: ${jobPageTitle(job)}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Notion sync complete", {
      total: data.count,
      created,
      updated,
      errors,
    });

    return {
      status: "ok",
      synced: created + updated,
      created,
      updated,
      errors,
    };
  },
});
