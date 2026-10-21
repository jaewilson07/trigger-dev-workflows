import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { runGate } from "../lib/backlogZeroGate.js";
import type { Issue, PaperclipGateApi } from "../lib/backlogZeroGate.js";

/**
 * Daily gate for Paperclip's "Backlog zero sweep (DAT-1563)" routine: count the
 * open tasks with no owner, and start ProjectManager's sweep only if there are
 * any. The rule and its reasons are in `../lib/backlogZeroGate.ts`.
 *
 * The routine has an `api` trigger only. Its sweep instructions live in the
 * routine's own description in Paperclip, not here. The gate authenticates as
 * ProjectManager with its own agent key ("trigger.dev backlog-zero-gate"), not
 * the board key, so revoking it touches nothing else.
 *
 * Paperclip API behaviour this relies on (checked 2026-10-21 against
 * paperclip.datacrew.space; the OpenAPI spec documents only `view`):
 * - `GET /api/companies/{id}/issues` accepts `status=a,b,c`, `limit` and
 *   `offset`, and returns a bare array capped at 500 rows by default.
 * - Unfiltered, the listing takes about 20 s. Filtered to open statuses, it
 *   takes about 7 s.
 */

const PAPERCLIP_URL = "https://paperclip.datacrew.space";
const COMPANY_ID = "9da83648-583b-4f62-9049-888eae6ad8ae";
const ROUTINE_ID = "4152ebb5-eed9-49a7-98c8-9e92f4cee64e";
const ROUTINE_TRIGGER_ID = "f424256f-9636-4624-869e-4b987b82e2b3";
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 60_000;
// Cloudflare's WAF in front of *.datacrew.space rejects some default client user agents.
const USER_AGENT = "trigger-dev-watchdog/paperclip-backlog-zero-gate";

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

async function paperclipFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${PAPERCLIP_URL}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`Paperclip ${init.method ?? "GET"} ${path} failed: ${response.status} ${body.slice(0, 500)}`);
  }
  return response.json();
}

function paperclipApi(apiKey: string): PaperclipGateApi {
  return {
    async listOpenIssues(): Promise<Issue[]> {
      const issues: Issue[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = (await paperclipFetch(
          apiKey,
          `/companies/${COMPANY_ID}/issues?status=backlog,todo,blocked&view=compact&limit=${PAGE_SIZE}&offset=${offset}`
        )) as Issue[];
        issues.push(...page);
        if (page.length < PAGE_SIZE) return issues;
      }
    },
    async fireRoutine(payload): Promise<void> {
      await paperclipFetch(apiKey, `/routines/${ROUTINE_ID}/run`, {
        method: "POST",
        body: JSON.stringify({
          triggerId: ROUTINE_TRIGGER_ID,
          source: "api",
          payload,
          // One sweep per day at most, even if this task is retried.
          idempotencyKey: `backlog-zero-gate:${String(payload.checkedAt).slice(0, 10)}`,
        }),
      });
    },
  };
}

export const paperclipBacklogZeroGate = schedules.task({
  id: "paperclip-backlog-zero-gate",
  cron: {
    pattern: "0 13 * * *",
    environments: ["PRODUCTION"],
  },
  maxDuration: 300,
  run: async () => {
    await safeAddTags(["paperclip", "backlog-zero"]);
    logger.info("starting paperclip-backlog-zero-gate");
    try {
      const apiKey = await getSecret("PAPERCLIP_BACKLOG_GATE_AGENT_KEY", { path: "/paperclip" });
      const result = await runGate(paperclipApi(apiKey), new Date());
      logger.info(
        result.fire
          ? "completed paperclip-backlog-zero-gate: sweep started"
          : "completed paperclip-backlog-zero-gate: backlog clean, sweep not started",
        result
      );
      return result;
    } catch (error) {
      logger.error("failed paperclip-backlog-zero-gate", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
