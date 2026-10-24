import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import {
  buildRows,
  formatDigest,
  needsAgent,
  OPEN_STATUSES,
} from "../lib/stallGate.js";
import type {
  Directory,
  GateIssue,
  GateRun,
  LastMessage,
  Row,
} from "../lib/stallGate.js";

/**
 * Deterministic Paperclip sweeps (no LLM). The rules and their reasons are in
 * `../lib/stallGate.ts`.
 *
 * - `paperclip-stall-gate` (every 3h, daytime Denver): classifies every open
 *   issue and fires ProjectManager's "Keep-moving sweep" routine through its
 *   `api` trigger **only** when some issue needs an agent to resume it. A
 *   quiet tick spends no model tokens.
 * - `paperclip-status-digest` (daily 07:45 Denver): posts the full list
 *   (project, issue, status, owner, last message, flags) to Slack for Jae,
 *   @mentioning him only when a card waits on him.
 *
 * Auth: ProjectManager's own agent key (`PAPERCLIP_BACKLOG_GATE_AGENT_KEY`,
 * shared with the backlog-zero gate). It can read issues, comments,
 * interactions, heartbeat-runs, agents and projects (checked 2026-10-24).
 * `GET /heartbeat-runs` ignores `status` and returns the newest 500 runs,
 * about 2.5 days, which covers the 24h stale window.
 */

const PAPERCLIP_URL = "https://paperclip.datacrew.space";
const COMPANY_ID = "9da83648-583b-4f62-9049-888eae6ad8ae";
const KEEP_MOVING_ROUTINE_ID = "f0f6a623-570c-4e88-a289-e5813585819d";
const KEEP_MOVING_API_TRIGGER_ID = "68885735-9617-4bf5-8ff8-fdce0595adb5";
const DIGEST_CHANNEL = "C0CA1L1PENA"; // #pc-software-factory
const JAE_SLACK_ID = "U08L4B485B4";
const PAGE_SIZE = 100;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT = "trigger-dev-watchdog/paperclip-stall-gate";

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    console.warn(
      "Skipping Trigger.dev tags outside managed runtime:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function paperclip(
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`${PAPERCLIP_URL}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(
      `Paperclip ${init.method ?? "GET"} ${path} failed: ${res.status} ${body.slice(0, 300)}`,
    );
  }
  return res.json();
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

type RawComment = {
  createdAt: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorType?: string;
};
type RawRun = GateRun & { contextSnapshot?: { issueId?: string } };

/** Read everything the gate needs. All reads; nothing here writes. */
export async function snapshot(apiKey: string): Promise<{ rows: Row[] }> {
  const issues: GateIssue[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = (await paperclip(
      apiKey,
      `/companies/${COMPANY_ID}/issues?status=${OPEN_STATUSES}&view=compact&limit=${PAGE_SIZE}&offset=${offset}`,
    )) as GateIssue[];
    issues.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const runs = (
    (await paperclip(
      apiKey,
      `/companies/${COMPANY_ID}/heartbeat-runs?limit=500`,
    )) as RawRun[]
  ).map((r) => ({
    ...r,
    issueId: r.contextSnapshot?.issueId ?? null,
  }));
  const agents = (await paperclip(
    apiKey,
    `/companies/${COMPANY_ID}/agents`,
  )) as { id: string; name: string }[];
  const projects = (await paperclip(
    apiKey,
    `/companies/${COMPANY_ID}/projects`,
  )) as { id: string; name: string }[];
  const dir: Directory = {
    agents: new Map(agents.map((a) => [a.id, a.name])),
    projects: new Map(projects.map((p) => [p.id, p.name])),
  };

  const last = new Map<string, LastMessage | null>();
  const cards = new Map<string, number>();
  await mapLimit(issues, CONCURRENCY, async (issue) => {
    const [comments, interactions] = await Promise.all([
      paperclip(apiKey, `/issues/${issue.id}/comments?limit=1`) as Promise<
        RawComment[]
      >,
      paperclip(apiKey, `/issues/${issue.id}/interactions`) as Promise<
        { status: string }[]
      >,
    ]);
    const c = comments[0];
    last.set(
      issue.id,
      c
        ? {
            at: c.createdAt,
            author: c.authorAgentId
              ? (dir.agents.get(c.authorAgentId) ?? "agent")
              : c.authorUserId
                ? "Jae"
                : "system",
            excerpt: c.body.replace(/\s+/g, " ").slice(0, 110),
          }
        : null,
    );
    cards.set(
      issue.id,
      interactions.filter((i) => i.status === "pending").length,
    );
  });
  return { rows: buildRows(issues, runs, last, cards, dir, new Date()) };
}

async function slackPost(
  token: string,
  body: Record<string, unknown>,
): Promise<{ ts: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ unfurl_links: false, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    ts?: string;
  };
  if (!res.ok || !data.ok || !data.ts)
    throw new Error(
      `Slack post failed: ${res.status} ${data.error ?? "unknown_error"}`,
    );
  return { ts: data.ts };
}

export const paperclipStallGate = schedules.task({
  id: "paperclip-stall-gate",
  cron: {
    pattern: "47 6-21/3 * * *",
    timezone: "America/Denver",
    environments: ["PRODUCTION"],
  },
  maxDuration: 600,
  run: async () => {
    await safeAddTags(["paperclip", "stall-gate"]);
    logger.info("starting paperclip-stall-gate");
    try {
      const apiKey = await getSecret("PAPERCLIP_BACKLOG_GATE_AGENT_KEY", {
        path: "/paperclip",
      });
      const { rows } = await snapshot(apiKey);
      const broken = needsAgent(rows);
      const checkedAt = new Date().toISOString();
      const result = {
        checkedAt,
        open: rows.length,
        broken: broken.length,
        needsJae: rows.filter((r) => r.signals.includes("needs_jae")).length,
        fired: false,
      };
      if (broken.length > 0) {
        await paperclip(apiKey, `/routines/${KEEP_MOVING_ROUTINE_ID}/run`, {
          method: "POST",
          body: JSON.stringify({
            triggerId: KEEP_MOVING_API_TRIGGER_ID,
            source: "api",
            payload: {
              source: "trigger.dev paperclip-stall-gate",
              checkedAt,
              // Worst first: the sweep resumes these, at most 3 re-wakes per run.
              issues: broken
                .slice(0, 30)
                .map((r) => ({
                  identifier: r.issue.identifier,
                  project: r.project,
                  status: r.issue.status,
                  owner: r.owner,
                  signals: r.signals,
                })),
            },
            // One sweep per 3h window, even if this task is retried.
            idempotencyKey: `stall-gate:${checkedAt.slice(0, 13)}`,
          }),
        });
        result.fired = true;
      }
      logger.info(
        result.fired
          ? "completed paperclip-stall-gate: sweep started"
          : "completed paperclip-stall-gate: nothing broken, sweep not started",
        result,
      );
      return result;
    } catch (error) {
      logger.error("failed paperclip-stall-gate", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

export const paperclipStatusDigest = schedules.task({
  id: "paperclip-status-digest",
  cron: {
    pattern: "45 7 * * *",
    timezone: "America/Denver",
    environments: ["PRODUCTION"],
  },
  maxDuration: 600,
  run: async () => {
    await safeAddTags(["paperclip", "status-digest"]);
    logger.info("starting paperclip-status-digest");
    try {
      const apiKey = await getSecret("PAPERCLIP_BACKLOG_GATE_AGENT_KEY", {
        path: "/paperclip",
      });
      const slackToken =
        process.env.DATACREW_SLACK_BOT_TOKEN ||
        (await getSecret("DATACREW_SLACK_BOT_TOKEN", { path: "/datacrew" }));
      const { rows } = await snapshot(apiKey);
      const now = new Date();
      const digest = formatDigest(rows, now, JAE_SLACK_ID);
      const { ts } = await slackPost(slackToken, {
        channel: DIGEST_CHANNEL,
        text: digest.summary,
      });
      for (const block of digest.projects)
        await slackPost(slackToken, {
          channel: DIGEST_CHANNEL,
          thread_ts: ts,
          text: block,
        });
      const result = {
        open: rows.length,
        projects: digest.projects.length,
        ts,
      };
      logger.info("completed paperclip-status-digest", result);
      return result;
    } catch (error) {
      logger.error("failed paperclip-status-digest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
