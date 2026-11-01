/**
 * Out-of-credits fallback for every Letta agent: when Letta Cloud's own model
 * quota runs out, move each agent on a Letta-tier model onto the house model
 * (a BYOK provider, which Letta still forwards to when the quota is
 * exhausted), and move it back once the quota returns.
 *
 * Which agents: discovery, not a list. Each tick every agent is judged, so a
 * new bot is covered on creation. Agents in the exclude list (matched by id or
 * name) are never touched: the quota probe must stay on the Letta tier to
 * detect the quota, and the paperclip-verify smoke tests should exercise it.
 * Agents on per-inference handles (`openai/*`, `anthropic/*`) draw on credits,
 * not the tier quota, and are left alone.
 *
 * Detection: `GET /v1/organizations/self/quotas` costs no inference and names
 * the window end. A quota rejection happens before Letta creates a run, so it
 * never appears in the runs API, and letta-channels only reports it as a
 * "Turn failed:" Slack message. Only if the quotas call fails does the task
 * ping a tiny probe agent on a Letta-tier model and read the rejection from
 * that response.
 *
 * State lives on each agent, so the task is stateless:
 * `metadata.auto_fallback = { previous, switched_at, resets_at }` marks a
 * switch and holds the model to restore. It is the same record the Paperclip
 * adapter writes (infra-bonker `letta-cloud/quota-fallback.ts`), so either
 * writer may revert a switch the other made. A house-model switch made by hand
 * has no record and is never reverted. (Agent `tags` would be the natural
 * marker, but Letta Cloud silently drops `tags` from an agent PATCH; checked
 * 2026-10-01.)
 *
 * Pinned conversations (DAT-1691): a conversation with its own `model` (every
 * Slack thread is minted with `letta/auto`) overrides the agent's model, so the
 * agent PATCH alone leaves it on the exhausted quota (probed 2026-10-26). On
 * switch, and on every tick while held, each conversation pinned to a `letta/*`
 * model is moved to the house model and its old model kept in
 * `auto_fallback.conversations` for the revert. Conversations with no pin
 * follow the agent and are left alone.
 *
 * Context fit: the house model runs a 98,304-token context (infra-cubby#245),
 * capped at 90,000 here. An agent whose current prompt plus a full reply
 * cannot fit is skipped with a log line; nothing is ever truncated.
 *
 * Slot contention: the house model has one llama.cpp slot, shared with mdrag.
 * Many agents on it at once queue behind each other, and a cold prefill of
 * Alix's ~63k-token prompt takes ~80 s. That is acceptable for a fallback.
 * Sleeptime agents are included; exclude them if their background work starves
 * the slot.
 *
 * Out of scope: `executive-assistant/lib/letta-fallback.ts` sends a
 * per-request `letta/auto-fast` override, which bypasses the agent's model and
 * so still hits the quota.
 */

export type ModelConfig = { model: string; context_window_limit: number; max_tokens: number };

export type FallbackRecord = {
  previous: ModelConfig;
  switched_at: string;
  resets_at?: string;
  /** Conversation id -> the model it was pinned to before we moved it to the house model. */
  conversations?: Record<string, string>;
};

/** A conversation's own model pin; `null` means it inherits the agent's model. */
export type ConversationState = { id: string; model: string | null };

export type ProbeResult = "ok" | "exhausted" | "unknown";

export type AgentState = {
  id: string;
  name: string;
  model: string;
  metadata: Record<string, unknown> | null;
  /** The agent's current llm_config, saved as `previous` when switching. */
  contextWindow?: number;
  maxTokens?: number;
};

type QuotaBucket = { bucket?: string; dailyBucket?: string };
export type Quotas = Record<string, unknown> & { quotaWindowEnd?: string; dailyQuotaWindowEnd?: string };

export type TierState = { state: "ok" | "exhausted" | "unknown"; until?: string };
export type TierStates = Record<string, TierState>;

export type Action =
  | { kind: "noop"; reason: string }
  | { kind: "skip"; reason: string }
  | { kind: "switch"; record: FallbackRecord }
  | { kind: "hold"; record: FallbackRecord }
  | { kind: "revert"; to: ModelConfig };

export type Summary = {
  agent: string;
  action: "noop" | "skip" | "switch" | "revert" | "error";
  reason: string;
};

export type LettaApi = {
  listAgents(): Promise<AgentState[]>;
  getQuotas(): Promise<Quotas>;
  /** Ping the probe agent; only used when getQuotas fails. */
  probe(): Promise<ProbeResult>;
  /** Estimated tokens the agent's current prompt occupies; may reject when it cannot be sized. */
  promptTokens(agentId: string): Promise<number | null>;
  patchAgent(agentId: string, body: Record<string, unknown>): Promise<void>;
  listConversations(agentId: string): Promise<ConversationState[]>;
  patchConversation(conversationId: string, model: string): Promise<void>;
};

const QUOTA_PATTERN = /inferences for this day|insufficient credits|quota (has been )?exceeded|quota resets in/i;

// With no window end to wait for, wait at least this long before trying the
// Letta model again.
const MIN_FALLBACK_MS = 60 * 60 * 1000;

/** Classify the probe's HTTP response. Only a recognisable quota message counts as exhausted. */
export function classifyProbe(status: number, body: string): ProbeResult {
  if (QUOTA_PATTERN.test(body)) return "exhausted";
  if (status >= 200 && status < 300) return "ok";
  return "unknown";
}

/** Pull the "Quota resets in ..." phrase out of a rejection, for logs. */
export function quotaResetHint(body: string): string | null {
  const m = body.match(/quota resets in[^.\n"]*/i);
  return m ? m[0] : null;
}

/** The quotas bucket a model draws on. Only Letta's own handles have one. */
export function tierFor(model: string): string | null {
  return model.startsWith("letta/") ? "lettaTier" : null;
}

const TIERS = ["lettaTier"];

/** Read each known tier's state out of a quotas response. */
export function tierStates(q: Quotas): TierStates {
  const out: TierStates = {};
  for (const tier of TIERS) {
    const b = q[tier] as QuotaBucket | undefined;
    if (!b) out[tier] = { state: "unknown" };
    else if (b.dailyBucket === "empty") out[tier] = { state: "exhausted", until: q.dailyQuotaWindowEnd };
    else if (b.bucket === "empty") out[tier] = { state: "exhausted", until: q.quotaWindowEnd };
    else out[tier] = { state: "ok" };
  }
  return out;
}

export function tierStatesFromProbe(probe: ProbeResult): TierStates {
  return Object.fromEntries(TIERS.map((t) => [t, { state: probe }]));
}

export function readFallback(metadata: AgentState["metadata"]): FallbackRecord | null {
  const fb = (metadata?.auto_fallback ?? null) as Partial<FallbackRecord> | null;
  const p = fb?.previous;
  if (!p?.model || !p.context_window_limit || !p.max_tokens) return null;
  return {
    previous: p as ModelConfig,
    switched_at: fb!.switched_at ?? "",
    resets_at: fb!.resets_at,
    ...(fb!.conversations ? { conversations: fb!.conversations } : {}),
  };
}

export type DecideCtx = {
  exclude: string[];
  promptTokens: () => Promise<number | null>;
  now: Date;
};

export async function decide(
  agent: AgentState,
  tiers: TierStates,
  house: ModelConfig,
  ctx: DecideCtx,
): Promise<Action> {
  if (ctx.exclude.includes(agent.id) || ctx.exclude.includes(agent.name)) {
    return { kind: "noop", reason: "excluded" };
  }
  const rec = readFallback(agent.metadata);

  if (agent.model === house.model) {
    if (!rec) return { kind: "noop", reason: "on house model by hand; leaving it" };
    const tier = tierFor(rec.previous.model);
    const state = tier ? tiers[tier]?.state ?? "unknown" : "ok";
    if (state === "unknown") return { kind: "noop", reason: "quota state unknown" };
    if (state === "exhausted") return { kind: "hold", record: rec };
    if (rec.resets_at && ctx.now < new Date(rec.resets_at)) {
      return { kind: "noop", reason: `waiting for quota window end ${rec.resets_at}` };
    }
    return { kind: "revert", to: rec.previous };
  }

  const tier = tierFor(agent.model);
  if (!tier) return { kind: "noop", reason: "per-inference handle; not on the tier quota" };
  const t = tiers[tier] ?? { state: "unknown" as const };
  if (t.state === "unknown") return { kind: "noop", reason: "quota state unknown" };
  if (t.state === "ok") return { kind: "noop", reason: "quota ok, on Letta model" };

  if (!agent.contextWindow || !agent.maxTokens) {
    return { kind: "skip", reason: "current model config incomplete; a switch could not be reverted" };
  }
  const tokens = await ctx.promptTokens();
  if (tokens === null) return { kind: "skip", reason: "prompt size unknown" };
  if (tokens + house.max_tokens > house.context_window_limit) {
    return {
      kind: "skip",
      reason: `prompt ${tokens} tokens + reply ${house.max_tokens} does not fit house context ${house.context_window_limit}`,
    };
  }
  return {
    kind: "switch",
    record: {
      previous: { model: agent.model, context_window_limit: agent.contextWindow, max_tokens: agent.maxTokens },
      switched_at: ctx.now.toISOString(),
      resets_at: t.until ?? new Date(ctx.now.getTime() + MIN_FALLBACK_MS).toISOString(),
    },
  };
}

/**
 * Letta Cloud has no /agents/{id}/context (404), so the prompt is sized from
 * the agent's compiled system message. Calibration, measured 2026-10-01:
 * 208k chars = 63.7k tokens (about 3.27 chars/token). Dividing by 3.0 over-
 * estimates on purpose: a wrong "fits" would switch an agent onto a model it
 * cannot hold, a wrong "too big" only skips.
 */
export function estimatePromptTokens(chars: number): number {
  return Math.ceil(chars / 3.0);
}

export type RunDeps = {
  house: ModelConfig;
  exclude: string[];
  now?: Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

/** Judge every agent; one agent's failure is logged and never stops the others. */
export async function runFallback(api: LettaApi, deps: RunDeps): Promise<Summary[]> {
  const now = deps.now ?? new Date();
  const log = deps.log ?? (() => {});

  let tiers: TierStates;
  try {
    tiers = tierStates(await api.getQuotas());
  } catch (e) {
    log("quotas call failed; falling back to ping probe", { error: String(e) });
    tiers = tierStatesFromProbe(await api.probe().catch(() => "unknown" as const));
  }

  const out: Summary[] = [];
  for (const agent of await api.listAgents()) {
    const label = agent.name || agent.id;
    try {
      const action = await decide(agent, tiers, deps.house, {
        exclude: deps.exclude,
        // Letta Cloud cannot always size a prompt; unknown means skip, never error.
        promptTokens: () =>
          api.promptTokens(agent.id).catch((e) => {
            log(`${label} prompt size lookup failed`, { error: String(e) });
            return null;
          }),
        now,
      });
      const metadata = { ...(agent.metadata ?? {}) };
      if (action.kind === "switch" || action.kind === "hold") {
        // A conversation pinned to its own model ignores the agent's, so move those too.
        const pinned = (await api.listConversations(agent.id)).filter((c) => c.model?.startsWith("letta/"));
        const conversations = { ...action.record.conversations, ...Object.fromEntries(pinned.map((c) => [c.id, c.model as string])) };
        const record: FallbackRecord = { ...action.record, ...(Object.keys(conversations).length ? { conversations } : {}) };
        if (action.kind === "hold" && !pinned.length) {
          out.push({ agent: label, action: "noop", reason: "already on house model" });
        } else {
          // Record first: if a conversation PATCH fails, the revert still knows what to restore.
          metadata.auto_fallback = record;
          await api.patchAgent(agent.id, action.kind === "switch" ? { ...deps.house, metadata } : { metadata });
          const failed: string[] = [];
          for (const c of pinned) {
            await api.patchConversation(c.id, deps.house.model).catch((e) => {
              failed.push(c.id);
              log(`${label} conversation ${c.id} not moved`, { error: String(e) });
            });
          }
          const moved = `${pinned.length - failed.length} conversation(s) moved`;
          out.push(
            failed.length
              ? { agent: label, action: "error", reason: `${moved}; failed: ${failed.join(", ")}` }
              : {
                  agent: label,
                  action: "switch",
                  reason:
                    action.kind === "switch"
                      ? `${action.record.previous.model} -> ${deps.house.model} until ${action.record.resets_at}; ${moved}`
                      : moved,
                },
          );
        }
      } else if (action.kind === "revert") {
        const rec = readFallback(agent.metadata);
        for (const [id, model] of Object.entries(rec?.conversations ?? {})) {
          await api.patchConversation(id, model).catch((e) => log(`${label} conversation ${id} not restored`, { error: String(e) }));
        }
        delete metadata.auto_fallback;
        await api.patchAgent(agent.id, { ...action.to, metadata });
        out.push({ agent: label, action: "revert", reason: `${deps.house.model} -> ${action.to.model}` });
      } else {
        out.push({ agent: label, action: action.kind, reason: action.reason });
      }
    } catch (e) {
      out.push({ agent: label, action: "error", reason: String(e instanceof Error ? e.message : e) });
    }
    const s = out[out.length - 1];
    if (s.action !== "noop") log(`${label} ${s.action}`, { reason: s.reason });
  }
  return out;
}
