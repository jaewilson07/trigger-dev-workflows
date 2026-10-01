/**
 * Alix's out-of-credits fallback: when Letta Cloud's own model quota runs out,
 * move Alix onto the house model (a BYOK provider, which Letta still forwards
 * to when the quota is exhausted), and move her back once the quota returns.
 *
 * Detection has to be active. A quota rejection happens before Letta creates a
 * run, so it never appears in the runs API, and letta-channels only reports it
 * as a "Turn failed:" Slack message. The task therefore pings a tiny probe
 * agent on a Letta-tier model and reads the rejection from that response.
 *
 * State lives on Alix herself, so the task is stateless: the `auto-fallback`
 * tag marks a switch this task made, and `metadata.auto_fallback.previous`
 * holds the model to restore. A house-model switch made by hand carries no tag
 * and is never reverted.
 */

export const FALLBACK_TAG = "auto-fallback";

export type ModelConfig = { model: string; context_window_limit: number; max_tokens: number };

export type ProbeResult = "ok" | "exhausted" | "unknown";

export type AgentState = {
  model: string;
  tags: string[];
  metadata: Record<string, unknown> | null;
};

export type Action =
  | { kind: "noop"; reason: string }
  | { kind: "switch-to-house" }
  | { kind: "revert"; to: ModelConfig };

const QUOTA_PATTERN = /inferences for this day|insufficient credits|quota (has been )?exceeded|quota resets in/i;

/** Classify the probe's HTTP response. Only a recognisable quota message counts as exhausted. */
export function classifyProbe(status: number, body: string): ProbeResult {
  if (QUOTA_PATTERN.test(body)) return "exhausted";
  if (status >= 200 && status < 300) return "ok";
  return "unknown";
}

export function previousModel(metadata: AgentState["metadata"]): ModelConfig | null {
  const fb = (metadata?.auto_fallback ?? null) as { previous?: Partial<ModelConfig> } | null;
  const p = fb?.previous;
  if (!p?.model || !p.context_window_limit || !p.max_tokens) return null;
  return { model: p.model, context_window_limit: p.context_window_limit, max_tokens: p.max_tokens };
}

export function decide(probe: ProbeResult, agent: AgentState, house: ModelConfig): Action {
  const onHouse = agent.model === house.model;
  const managed = agent.tags.includes(FALLBACK_TAG);
  if (probe === "unknown") return { kind: "noop", reason: "probe inconclusive" };
  if (probe === "exhausted") {
    return onHouse ? { kind: "noop", reason: "already on house model" } : { kind: "switch-to-house" };
  }
  if (!onHouse) return { kind: "noop", reason: "quota ok, on Letta model" };
  if (!managed) return { kind: "noop", reason: "on house model by hand; leaving it" };
  const to = previousModel(agent.metadata);
  if (!to) return { kind: "noop", reason: "managed but no previous model recorded" };
  return { kind: "revert", to };
}

/** Pull the "Quota resets in ..." phrase out of a rejection, for logs. */
export function quotaResetHint(body: string): string | null {
  const m = body.match(/quota resets in[^.\n"]*/i);
  return m ? m[0] : null;
}
