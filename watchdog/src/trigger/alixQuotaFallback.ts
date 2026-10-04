import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import {
  classifyProbe,
  decide,
  quotaResetHint,
} from "../lib/alixQuotaFallback.js";
import type { Action, AgentState, ModelConfig } from "../lib/alixQuotaFallback.js";

/**
 * Every 5 minutes: is Letta Cloud's model quota exhausted? If so, move Alix to
 * the house model; once it's back, move her back. Decision logic and the why
 * of the probe agent live in `../lib/alixQuotaFallback.ts`.
 *
 * Each probe spends one Letta-tier inference (~288/day against a 30,000/day
 * quota). The probe agent has no tools and auto-clears its history, so each
 * ping stays tiny.
 */

const LETTA_API = (process.env.LETTA_BASE_URL || "https://api.letta.com").replace(/\/$/, "") + "/v1";
const ALIX_AGENT_ID = process.env.ALIX_AGENT_ID || "agent-64b31ced-0bae-4cde-bb9b-af4a9f974588";
const PROBE_AGENT_NAME = "letta-quota-probe";
const PROBE_MODEL = "letta/auto-chat";
// llama-chat-swap on cubby runs --ctx-size 98304 (infra-cubby#245); Alix's
// prompt alone is ~63k tokens, so leave headroom for the turn.
const HOUSE: ModelConfig = { model: "gateway/qwen3.8-27b", context_window_limit: 90000, max_tokens: 4096 };

type LettaAgent = {
  id: string;
  model?: string;
  metadata?: Record<string, unknown> | null;
  llm_config?: { context_window?: number; max_tokens?: number };
};

async function letta(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${LETTA_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  });
}

async function lettaJson<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await letta(apiKey, path, init);
  if (!res.ok) throw new Error(`Letta ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function probeAgentId(apiKey: string): Promise<string> {
  const found = await lettaJson<LettaAgent[]>(apiKey, `/agents/?name=${PROBE_AGENT_NAME}&limit=1`);
  if (found[0]) return found[0].id;
  const created = await lettaJson<LettaAgent>(apiKey, "/agents/", {
    method: "POST",
    body: JSON.stringify({
      name: PROBE_AGENT_NAME,
      model: PROBE_MODEL,
      memory_blocks: [],
      tools: [],
      include_base_tools: false,
      message_buffer_autoclear: true,
      tags: ["system", "quota-probe"],
      description: "Pinged by trigger.dev alix-quota-fallback to detect Letta quota exhaustion.",
    }),
  });
  logger.info("created probe agent", { id: created.id });
  return created.id;
}

async function applyAction(apiKey: string, alix: LettaAgent, action: Action): Promise<void> {
  const metadata = { ...(alix.metadata ?? {}) };
  if (action.kind === "switch-to-house") {
    metadata.auto_fallback = {
      previous: {
        model: alix.model,
        context_window_limit: alix.llm_config?.context_window,
        max_tokens: alix.llm_config?.max_tokens,
      },
      switched_at: new Date().toISOString(),
    };
    await lettaJson(apiKey, `/agents/${alix.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...HOUSE,
        metadata,
      }),
    });
  } else if (action.kind === "revert") {
    delete metadata.auto_fallback;
    await lettaJson(apiKey, `/agents/${alix.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...action.to,
        metadata,
      }),
    });
  }
}

export const alixQuotaFallback = schedules.task({
  id: "alix-quota-fallback",
  cron: "*/5 * * * *",
  maxDuration: 300,
  run: async () => {
    logger.info("starting quota probe", { probeAgent: PROBE_AGENT_NAME, alix: ALIX_AGENT_ID });
    const apiKey = await getSecret("LETTA_API_KEY", { path: "/letta" });

    const probeId = await probeAgentId(apiKey);
    const res = await letta(apiKey, `/agents/${probeId}/messages`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "ping" }], max_steps: 1 }),
    });
    const body = await res.text();
    const probe = classifyProbe(res.status, body);
    if (probe === "unknown") logger.warn("probe inconclusive", { status: res.status, body: body.slice(0, 300) });

    const alix = await lettaJson<LettaAgent>(apiKey, `/agents/${ALIX_AGENT_ID}`);
    const state: AgentState = { model: alix.model ?? "", metadata: alix.metadata ?? null };
    const action = decide(probe, state, HOUSE);

    await applyAction(apiKey, alix, action);
    if (action.kind !== "noop") {
      try {
        await tags.add(["alix", action.kind]);
      } catch {
        // tags are cosmetic; outside the managed runtime they aren't available
      }
      logger.info(`alix ${action.kind}`, { from: alix.model, resetHint: quotaResetHint(body) });
    }
    logger.info("completed quota probe", { probe, action: action.kind });
    return { probe, action: action.kind, reason: action.kind === "noop" ? action.reason : undefined, model: alix.model };
  },
});
