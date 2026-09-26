import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";

/**
 * Replaces `.github/workflows/ensure-reflection-schedule.yml` (daily
 * `15 12 * * *` UTC + `workflow_dispatch`), per ADR-054
 * (`.agents/adrs/ADR-054-trigger-dev-is-the-orchestration-layer-not-github-actions.md`).
 *
 * Reconciliation task, no human first-class participant, keeps another
 * system (Letta's reflection schedule) correct on a cron — squarely
 * `watchdog`'s domain per `docs/ADR-001-project-boundaries.md`.
 *
 * FIXED 2026-09-26 (was failing every run since deploy on 2026-09-11):
 * the original port shelled out to `uv run python
 * libraries/mdrag-agents/scripts/register_reflection_schedule.py` against a
 * fresh clone of the umbrella (`jaewilson07/simpleDiscordBot`). That always
 * failed at the `uv` step, before the script path was even reached — the
 * umbrella's `libraries/*` are separate git repos, gitignored since
 * `adc404244` ("remove all submodules, replace with .gitignore +
 * bootstrap.sh", 2026-04-13), so a plain clone has no `libraries/cboti`,
 * `libraries/mdrag`, etc. on disk, yet the umbrella's root `pyproject.toml`
 * still declares them as `{ workspace = true }` members — `uv run` fails
 * immediately with "`cboti` references a workspace ... but is not a
 * workspace member" for every single caller, regardless of which script it
 * wanted to run. `bootstrap.sh` (the supported way to reproduce the
 * workspace) was never invoked by this task.
 *
 * Separately — and this would have surfaced next even with a working
 * clone — the target script never survived `mdrag-agents`'s merge into
 * `libraries/mdrag` (confirmed both then and now: no
 * `reflection_schedule`/`SECOND_BRAIN_REFLECTION` hits anywhere under
 * `libraries/mdrag`). Its logic was recovered from the umbrella's git
 * history (last committed at `d802f1cf5`, before `mdrag-agents` became a
 * private submodule: `libraries/mdrag-agents/src/mdrag_agents/sleeptime.py`
 * + `models.py`) — a thin wrapper around Letta's own schedule REST API
 * (`GET/POST /v1/agents/{agent_id}/schedule`, confirmed against the
 * `letta_client` Python SDK's generated `resources/agents/schedule.py`).
 *
 * Rather than rebuild a Python script this task would have to clone+`uv
 * sync` a whole monorepo just to run once, this port calls that same Letta
 * REST API directly with `fetch` — no clone, no `uv`, no Python at all.
 * That's also the fix the task instructions asked for first: "removes the
 * fragile pattern ... e.g. calling an HTTP API the target service already
 * exposes."
 *
 * `SECOND_BRAIN_REFLECTION_CONVERSATION_ID` is still read from env (for
 * parity with the original workflow's contract, in case something
 * downstream keys off it) but is NOT sent to Letta: the schedule-create API
 * has no `conversation_id` field (verified against `ScheduleCreateParams`
 * in the `letta_client` SDK), and the pre-submodule version of the script
 * this was ported from didn't reference it either. Flagging this rather
 * than silently dropping it — if a later version of the original script
 * actually used it for something, that's a gap in this port.
 */

// Original workflow read these from GH Actions `vars` (not `secrets`), with
// literal fallback defaults baked into the workflow file itself — preserved
// here as the same hardcoded fallbacks rather than promoting them to
// Infisical secrets they never were.
const DEFAULT_AGENT_ID = "agent-64b31ced-0bae-4cde-bb9b-af4a9f974588";
const DEFAULT_CONVERSATION_ID = "conv-cf160695-f847-43b0-b223-10cfa28fa3b0";
// Matches `mdrag_agents.models.SleeptimeRequest`'s own field defaults
// (recovered from git history, see module doc above) — the original script
// never baked a fallback into the workflow file for these two, so an unset
// env var fell through to the script's own Pydantic defaults.
const DEFAULT_CRON_EXPRESSION = "0 8 * * *";
const DEFAULT_REFLECTION_MESSAGE =
  "[SYSTEM-REFLECTION] Review recent agent conversations from the last 24 hours. " +
  "Extract durable user preferences, project decisions, unresolved problems, and any facts " +
  "worth promoting into memory_facts. If there is nothing durable, respond with ACKNOWLEDGED.";
// Not in the original script (it required `LETTA_BASE_URL`/`LETTA_API_BASE`
// and exited if neither was set) — this project has no such env var
// configured (confirmed: not in this Trigger.dev project's env vars, and
// the original task's fallback of `""` would have failed here too, just
// one step further along than the `uv` failure). `https://api.letta.com`
// matches the org-wide documented default for a Letta Cloud agent
// (`docs/project_notes/key_facts.md`, `indb_discordbot`'s own
// `LETTA_BASE_URL` default) — override with a project env var if this
// reflection agent ever moves off Letta Cloud.
const DEFAULT_LETTA_BASE_URL = "https://api.letta.com";

type EnsureReflectionSchedulePayload = {
  timestamp: Date | string;
  timezone: string;
};

type LettaScheduleType = "recurring" | "one-time";

type LettaScheduledMessage = {
  id: string;
  agent_id: string;
  message: {
    messages: Array<{ role: string; content: unknown }>;
  };
  schedule:
    | { type: "recurring"; cron_expression: string }
    | { type: "one-time"; scheduled_at: number };
};

type LettaScheduleListResponse = {
  has_next_page: boolean;
  scheduled_messages: LettaScheduledMessage[];
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

/** Thin fetch wrapper matching `letta_client`'s auth/base-url handling. */
async function lettaFetch(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`Letta API ${init.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }
  return response;
}

async function listSchedules(
  baseUrl: string,
  apiKey: string,
  agentId: string
): Promise<LettaScheduledMessage[]> {
  const response = await lettaFetch(baseUrl, apiKey, `/v1/agents/${agentId}/schedule`);
  const data = (await response.json()) as LettaScheduleListResponse;
  return data.scheduled_messages ?? [];
}

function scheduleMatches(schedule: LettaScheduledMessage, cronExpression: string, message: string): boolean {
  if (schedule.schedule.type !== "recurring") return false;
  if (schedule.schedule.cron_expression !== cronExpression) return false;
  const firstContent = schedule.message.messages[0]?.content;
  return firstContent === message;
}

async function createSchedule(
  baseUrl: string,
  apiKey: string,
  agentId: string,
  cronExpression: string,
  message: string
): Promise<LettaScheduledMessage> {
  const response = await lettaFetch(baseUrl, apiKey, `/v1/agents/${agentId}/schedule`, {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: message, type: "message" }],
      schedule: { type: "recurring" as LettaScheduleType, cron_expression: cronExpression },
    }),
  });
  return (await response.json()) as LettaScheduledMessage;
}

async function runEnsureReflectionSchedule(): Promise<{ status: string; scheduleId: string }> {
  await safeAddTags(["reflection-schedule", "letta", "mdrag"]);
  logger.info("starting ensure-reflection-schedule");

  // Letta Cloud key lives at /letta, not /datacrew — matches
  // trigger.config.ts's own SYNCED_SECRETS comment on this distinction.
  const lettaApiKey = await getSecret("LETTA_API_KEY", { path: "/letta" });

  const agentId = process.env.SECOND_BRAIN_REFLECTION_AGENT_ID || DEFAULT_AGENT_ID;
  const conversationId = process.env.SECOND_BRAIN_REFLECTION_CONVERSATION_ID || DEFAULT_CONVERSATION_ID;
  const cronExpression = process.env.SECOND_BRAIN_REFLECTION_CRON || DEFAULT_CRON_EXPRESSION;
  const reflectionMessage = process.env.SECOND_BRAIN_REFLECTION_MESSAGE || DEFAULT_REFLECTION_MESSAGE;
  const lettaBaseUrl =
    process.env.LETTA_BASE_URL || process.env.LETTA_API_BASE || DEFAULT_LETTA_BASE_URL;

  logger.info("resolved reflection schedule config", {
    agentId,
    conversationId,
    cronExpression,
    lettaBaseUrl,
  });

  const existing = await listSchedules(lettaBaseUrl, lettaApiKey, agentId);
  const match = existing.find((schedule) => scheduleMatches(schedule, cronExpression, reflectionMessage));

  if (match) {
    logger.info("reusing existing reflection schedule", { scheduleId: match.id, agentId });
    return { status: "already-exists", scheduleId: match.id };
  }

  const created = await createSchedule(lettaBaseUrl, lettaApiKey, agentId, cronExpression, reflectionMessage);
  logger.info("created reflection schedule", { scheduleId: created.id, agentId, cronExpression });
  return { status: "created", scheduleId: created.id };
}

export const ensureReflectionSchedule = schedules.task({
  id: "ensure-reflection-schedule",
  cron: {
    pattern: "15 12 * * *",
    environments: ["PRODUCTION"],
  },
  maxDuration: 60,
  run: async (_payload: EnsureReflectionSchedulePayload) => {
    try {
      return await runEnsureReflectionSchedule();
    } catch (error) {
      logger.error("failed ensure-reflection-schedule", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
