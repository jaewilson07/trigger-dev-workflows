/**
 * Letta Cloud fallback for `lib/gateway-llm.ts`, used when the local gateway
 * (`http://gateway:7630`, qwen3.5-9b) cannot serve a request.
 *
 * Note this is not a rare emergency path: the gateway proxies to llama-swap on
 * `cubby.lan`, and cubby is intentionally powered down much of the time. When
 * it is, this is THE path.
 *
 * WHY LETTA CLOUD AND NOT THE SELF-HOSTED letta-server. The per-user agents
 * that mdrag provisions live on bonker's `letta-server`, whose ONLY registered
 * provider is `llama-swap` -> `http://gateway:7630/v1` -- the same gateway
 * this is a fallback FOR. Verified live on 2026-08-01: with cubby down,
 * messaging a per-user agent on letta-server returns
 * `llm_error: Failed to connect to OpenAI: Connection error.` A fallback there
 * would fall back onto the exact dependency that just failed. Letta Cloud is
 * independent infrastructure, so that is where this points.
 *
 * WHICH AGENT. Jae's standing direction: each user gets ONE Letta agent across
 * every surface, not one per product. The canonical name is mdrag's --
 * `mdrag_user_{sha256(lowercased email)[:12]}` -- and `userAgentName` below
 * duplicates that derivation verbatim (see `letta-fallback.test.ts`). It is a
 * cross-repo LOOKUP KEY: deriving it differently silently gives one person two
 * agents with two separate memories, and fails invisibly because both agents
 * work fine, they just share nothing.
 *
 * The Cloud agent is necessarily distinct from the same-named one on
 * letta-server -- two servers cannot share agent state -- but the name stays
 * identical so the lookup resolves the same way from any surface.
 *
 * WHY `letta/auto-fast` AND NOT `letta/auto`. mdrag confirmed live that an
 * agent's own `letta/auto` default sometimes routes a plain pinned-shape
 * request to a heavy reasoner (observed: zai-org/GLM-5.2), which burns its
 * whole `max_tokens` budget on reasoning and returns `finish_reason: length`
 * with EMPTY content. `letta/auto-fast` reproduced the same request with
 * `reasoning_tokens=0`. This is a per-REQUEST override, so it does not
 * repoint the shared agent's own default -- which matters, because the agent
 * belongs to the user, not to this task.
 *
 * WHY A `letta/*` HANDLE AT ALL (and not `openai/gpt-4o-mini`, which is what
 * the stashed `pipeline.ts` fell back to). Letta Cloud tiers its handles:
 * `letta/*` are covered by the Pro plan, while `openai/*` are
 * `per-inference`, billed against CREDITS this account does not have.
 * pattern-hunter 402'd on every message with `reasons:["not-enough-credits"]`
 * until it moved to `letta/auto` on 2026-07-30.
 *
 * WHY CALLERS MUST BATCH. A Letta agent replays its entire accumulated
 * conversation on every turn. Measured live on 2026-08-01: a single triage
 * question against an agent with real history cost 52,344 prompt tokens to
 * produce a 38-token answer. Triaging N emails as N turns pays that N times
 * AND writes N machine-generated turns into the user's personal agent memory.
 * `gateway-llm.ts` therefore sends the whole inbox in ONE message. Do not
 * "simplify" that back into a per-email loop on this path.
 *
 * CONCURRENCY. A Letta agent is one stateful conversation, so two callers
 * 409 each other. Batching helps here too -- one request per brief instead of
 * N -- but this agent is shared with every other surface the user touches
 * (Slack, mermaid, pattern-hunter), so a collision is possible in a way it
 * would not be for a dedicated agent. The bounded 409 retry below is load
 * bearing for that reason, not merely a safety net.
 */

import { createHash } from "node:crypto";
import { getSecret, isInfisicalConfigured } from "./infisical.js";

const LETTA_BASE_URL = (process.env.LETTA_BASE_URL ?? "https://api.letta.com").replace(/\/+$/, "");
const USER_EMAIL = process.env.MORNING_BRIEF_USER_EMAIL ?? "";
const LETTA_MODEL = process.env.LETTA_TRIAGE_MODEL ?? "letta/auto-fast";

const MAX_409_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const LETTA_TIMEOUT_MS = 180_000;

/**
 * Stable agent name for a user email.
 *
 * Verbatim port of mdrag's `integrations/letta/user_agents.py:user_agent_name`
 * -- `sha256` of the LOWERCASED email, first 12 hex chars, `mdrag_user_`
 * prefix. Covered by `letta-fallback.test.ts` against a value computed from
 * the Python original; if that test fails, this has drifted from mdrag and
 * the user's agent will not resolve.
 */
export function userAgentName(email: string): string {
  const hash = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
  return `mdrag_user_${hash}`;
}

/**
 * True when the fallback has a chance of working.
 *
 * The email must be set (without it there is no agent name to resolve), and
 * the key must be reachable -- either directly in the environment or via
 * Infisical's machine identity. This is deliberately a cheap synchronous
 * check rather than an actual credential fetch: callers use it to decide
 * whether to fall back or rethrow the gateway's own error, and doing a
 * network round trip inside that decision would mask a gateway outage behind
 * an unrelated Infisical failure.
 */
export function isLettaFallbackConfigured(): boolean {
  const keyReachable = Boolean(process.env.LETTA_API_KEY) || isInfisicalConfigured();
  return keyReachable && USER_EMAIL !== "";
}

async function authHeaders(): Promise<Record<string, string>> {
  // Fetched per call rather than captured at module load: `getSecret` caches
  // internally, and reading it lazily means an unconfigured local run never
  // touches Infisical at all.
  const key = await getSecret("LETTA_API_KEY");
  if (!key) {
    throw new Error(
      "LETTA_API_KEY is not resolvable — set it directly, or set " +
        "INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET so it can be read from Infisical"
    );
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}

// Resolved once per process: the name -> id lookup is a full agent listing,
// and the mapping cannot change under a running task.
let cachedAgentId: string | null = null;

/**
 * Resolve the user's agent id by name.
 *
 * Deliberately does NOT create the agent when missing. mdrag owns
 * provisioning (`get_or_create_user_agent`), and creating one here with this
 * surface's idea of the right persona/embedding is how two divergent agents
 * for one person get started. A missing agent is an error worth seeing.
 */
export async function resolveUserAgentId(): Promise<string> {
  if (cachedAgentId !== null) return cachedAgentId;

  const name = userAgentName(USER_EMAIL);
  const res = await fetch(`${LETTA_BASE_URL}/v1/agents/?limit=200`, {
    headers: await authHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Letta agent lookup failed: ${res.status} ${await res.text()}`);
  }
  const agents = (await res.json()) as Array<{ id?: string; name?: string }>;
  const match = agents.find((a) => a.name === name);
  if (!match?.id) {
    throw new Error(
      `Letta agent "${name}" not found for ${USER_EMAIL} — mdrag provisions it ` +
        `(integrations/letta/user_agents.py); this task does not create it`
    );
  }
  cachedAgentId = match.id;
  return cachedAgentId;
}

type LettaMessage = {
  message_type?: string;
  content?: string | Array<{ text?: string }>;
};

/**
 * Send one message to the user's agent and return its assistant text.
 *
 * Concatenates every `assistant_message` in the response -- a Letta turn can
 * emit several (the agent may narrate before answering), and keeping only the
 * first silently loses content.
 */
export async function lettaSend(message: string): Promise<string> {
  if (!isLettaFallbackConfigured()) {
    throw new Error(
      "Letta fallback is not configured — set MORNING_BRIEF_USER_EMAIL, plus either " +
        "LETTA_API_KEY or INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET"
    );
  }
  const agentId = await resolveUserAgentId();
  const headers = await authHeaders();

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_409_RETRIES; attempt++) {
    const res = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: message }],
        override_model: LETTA_MODEL,
      }),
      signal: AbortSignal.timeout(LETTA_TIMEOUT_MS),
    });

    if (res.status === 409 && attempt < MAX_409_RETRIES) {
      // Another surface (Slack, mermaid, pattern-hunter) is mid-turn on this
      // same agent. Backs off rather than failing the brief.
      lastError = new Error(`Letta 409 (agent busy) on attempt ${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      // Surface the body: a 402 here means the request landed on a
      // credit-billed handle (see the module docstring), which is not
      // obvious from the status code alone.
      throw new Error(`Letta error: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { messages?: LettaMessage[] };
    const parts: string[] = [];
    for (const msg of data.messages ?? []) {
      if (msg.message_type !== "assistant_message") continue;
      if (typeof msg.content === "string") {
        if (msg.content.trim()) parts.push(msg.content.trim());
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.text?.trim()) parts.push(block.text.trim());
        }
      }
    }
    if (parts.length === 0) {
      throw new Error(`Letta returned no assistant message: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return parts.join("\n\n");
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Letta agent ${agentId} stayed busy after ${MAX_409_RETRIES} retries`);
}

const FENCE_RE = /^```(?:\w+)?\s*\n|\n```\s*$/gm;
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;
const TOOL_CALL_TAG_RE = /<\/?tool_call>|<\/?tool_response>|\[\/?TOOL_CALLS\]/gi;
const JSON_OBJECT_RE = /\{[\s\S]*\}/;

/**
 * Unwrap `{"name": ..., "arguments": {...}}` down to the arguments.
 *
 * A model asked for structured output sometimes answers as if CALLING a
 * function. Ported from mdrag's `extract_json`, itself ported from
 * pattern-hunter's `main.py:_extract_json`.
 */
function unwrapToolCallEnvelope(obj: Record<string, unknown>): Record<string, unknown> {
  for (const argKey of ["arguments", "parameters"]) {
    const keys = Object.keys(obj);
    if (
      keys.length === 2 &&
      keys.includes("name") &&
      keys.includes(argKey) &&
      typeof obj.name === "string" &&
      typeof obj[argKey] === "object" &&
      obj[argKey] !== null &&
      !Array.isArray(obj[argKey])
    ) {
      return obj[argKey] as Record<string, unknown>;
    }
  }
  return obj;
}

/**
 * Best-effort extraction of a JSON object from an LLM's prose reply.
 *
 * Needed because neither backend enforces an output schema -- Letta's
 * agent-messaging API has no schema mechanism at all, and the gateway ignores
 * response schemas -- so the reply is plain text that may be fenced, wrapped
 * in `<think>` blocks or tool-call tags, or embedded mid-sentence. Tries each
 * strategy in order and returns the first that parses to an object.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const stripped = text.replace(FENCE_RE, "").trim();
  const cleaned = stripped.replace(THINK_BLOCK_RE, "").replace(TOOL_CALL_TAG_RE, "").trim();

  const candidates: string[] = [stripped];
  if (cleaned !== stripped) candidates.push(cleaned);
  for (const source of [cleaned, stripped]) {
    const match = source.match(JSON_OBJECT_RE);
    if (match) {
      candidates.push(match[0]);
      break;
    }
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return unwrapToolCallEnvelope(parsed as Record<string, unknown>);
      }
    } catch {
      // Try the next strategy — a failure here is expected, not exceptional.
    }
  }
  return null;
}
