import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { classifyProbe, estimatePromptTokens, runFallback } from "../lib/lettaQuotaFallback.js";
import type { AgentState, LettaApi, ModelConfig, ProbeResult } from "../lib/lettaQuotaFallback.js";

/**
 * Every 5 minutes: is Letta Cloud's model quota exhausted? If so, move every
 * Letta-tier agent to the house model; once it's back, move them back.
 * Decision logic, the record shape and the why live in
 * `../lib/lettaQuotaFallback.ts`.
 *
 * The quotas API costs no inference. Only if it fails does the task ping the
 * probe agent, which spends one Letta-tier inference (the probe agent has no
 * tools and auto-clears its history, so each ping stays tiny).
 *
 * Slot contention: the house model has one llama.cpp slot shared with mdrag, so
 * many agents on it at once queue behind each other (a cold Alix prefill takes
 * ~80 s). Acceptable for a fallback.
 *
 * Excluded agents (ids or names, comma-separated in LETTA_QUOTA_FALLBACK_EXCLUDE):
 * the probe must stay on the Letta tier to detect the quota, and the
 * paperclip-verify smoke tests should exercise the Letta tier.
 */

const LETTA_API = (process.env.LETTA_BASE_URL || "https://api.letta.com").replace(/\/$/, "") + "/v1";
const PROBE_AGENT_NAME = "letta-quota-probe";
const PROBE_MODEL = "letta/auto-chat";
const EXCLUDE = (process.env.LETTA_QUOTA_FALLBACK_EXCLUDE ?? `${PROBE_AGENT_NAME},paperclip-verify`)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// llama-chat-swap on cubby runs --ctx-size 98304 (infra-cubby#245); leave headroom for the turn.
const HOUSE: ModelConfig = { model: "gateway/qwen3.8-27b", context_window_limit: 90000, max_tokens: 4096 };
const PAGE = 100;

type LettaAgent = {
  id: string;
  name?: string;
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
      description: "Pinged by trigger.dev letta-quota-fallback to detect Letta quota exhaustion.",
    }),
  });
  logger.info("created probe agent", { id: created.id });
  return created.id;
}

function liveApi(apiKey: string): LettaApi {
  return {
    async listAgents() {
      const all: LettaAgent[] = [];
      for (;;) {
        const after = all.length ? `&after=${all[all.length - 1].id}` : "";
        const page = await lettaJson<LettaAgent[]>(apiKey, `/agents/?limit=${PAGE}${after}`);
        all.push(...page);
        if (page.length < PAGE) break;
      }
      return all.map(
        (a): AgentState => ({
          id: a.id,
          name: a.name ?? "",
          model: a.model ?? "",
          metadata: a.metadata ?? null,
          contextWindow: a.llm_config?.context_window,
          maxTokens: a.llm_config?.max_tokens,
        }),
      );
    },
    getQuotas: () => lettaJson(apiKey, "/organizations/self/quotas"),
    async probe(): Promise<ProbeResult> {
      const probeId = await probeAgentId(apiKey);
      const res = await letta(apiKey, `/agents/${probeId}/messages`, {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "ping" }], max_steps: 1 }),
      });
      return classifyProbe(res.status, await res.text());
    },
    async promptTokens(agentId) {
      // The first message of an agent is its compiled system prompt.
      const msgs = await lettaJson<Array<{ content?: unknown }>>(apiKey, `/agents/${agentId}/messages?limit=1&order=asc`);
      const content = msgs[0]?.content;
      if (typeof content === "string") return estimatePromptTokens(content.length);
      if (Array.isArray(content)) {
        const chars = content.reduce((n, part) => n + (typeof part?.text === "string" ? part.text.length : 0), 0);
        return estimatePromptTokens(chars);
      }
      return null;
    },
    async patchAgent(agentId, body) {
      await lettaJson(apiKey, `/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(body) });
    },
  };
}

export const lettaQuotaFallback = schedules.task({
  id: "letta-quota-fallback",
  cron: "*/5 * * * *",
  maxDuration: 300,
  run: async () => {
    logger.info("starting quota check", { exclude: EXCLUDE });
    const apiKey = await getSecret("LETTA_API_KEY", { path: "/letta" });
    const summary = await runFallback(liveApi(apiKey), {
      house: HOUSE,
      exclude: EXCLUDE,
      log: (msg, data) => logger.info(msg, data),
    });
    const changed = summary.filter((s) => s.action !== "noop");
    for (const s of summary.filter((s) => s.action === "skip" || s.action === "error")) {
      logger.warn(`${s.agent} ${s.action}`, { reason: s.reason });
    }
    if (changed.length) {
      try {
        await tags.add(["letta", ...new Set(changed.map((s) => s.action))]);
      } catch {
        // tags are cosmetic; outside the managed runtime they aren't available
      }
    }
    logger.info("completed quota check", { agents: summary.length, changed: changed.length });
    return summary;
  },
});
