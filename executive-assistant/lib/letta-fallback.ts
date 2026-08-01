/**
 * Letta Cloud fallback for `lib/gateway-llm.ts`, used only when the local
 * gateway (`http://gateway:7630`, qwen3.5-9b) is unreachable.
 *
 * WHY NOT JUST REPOINT GATEWAY_URL AT LETTA. Letta Cloud does expose
 * `/v1/chat/completions`, but mdrag confirmed live against it that (1) only
 * `stream=true` is implemented at all, and (2) `tools`/`tool_choice` are
 * silently ignored -- the agent only ever uses its own built-in Letta tools.
 * So it is not a drop-in OpenAI-compatible endpoint. This module uses the
 * real agent-messaging API (`POST /v1/agents/{id}/messages`) instead, the
 * same one mdrag's `integrations/llm/letta_completion.py` and pattern-hunter
 * already use successfully, and asks for JSON in plain prose.
 *
 * WHY `letta/auto-fast` AND NOT `letta/auto`. mdrag confirmed live that an
 * agent's own `letta/auto` default sometimes routes a plain extraction
 * request to a heavy reasoner (observed: zai-org/GLM-5.2), which burns its
 * whole `max_tokens` budget on reasoning and returns `finish_reason: length`
 * with EMPTY content -- on a schema no more complex than any other.
 * `letta/auto-fast` reproduced the same request with `reasoning_tokens=0`.
 * Email triage is a classification with a pinned output shape, so reasoning
 * capacity adds latency without adding precision. mdrag pins its FAST role
 * to `auto-fast` for exactly this reason.
 *
 * WHY A `letta/*` HANDLE AND NOT `openai/gpt-4o-mini` (which is what the
 * stashed `pipeline.ts` fell back to). Letta Cloud models are tiered, and
 * the tier decides whether a call works at all: `letta/*` handles are
 * covered by the Pro plan, while `openai/*` are `per-inference` and billed
 * against CREDITS. This account has no credits -- pattern-hunter's every
 * message 402'd with `reasons:["not-enough-credits"]` until it was moved
 * onto `letta/auto` on 2026-07-30. `letta/*` handles also carry a 180000
 * context window.
 *
 * CONCURRENCY. A Letta agent is ONE stateful conversation: two callers
 * hitting it at once get a 409 ("another request is currently being
 * processed"). mdrag needed a process-wide lock because its `/brief` fires
 * four concurrent extract calls; this path does not, because
 * `tasks/triage-emails.ts` awaits one email at a time in a plain `for` loop.
 * Two things follow, and both matter:
 *   1. LETTA_TRIAGE_AGENT_ID must name an agent DEDICATED to this task. Do
 *      not point it at mdrag's shared `mdrag_llm_fast` -- mdrag's in-process
 *      lock cannot see calls from this container, so the two would 409 each
 *      other with no coordination.
 *   2. If triage is ever changed to fan out (Promise.all, or a per-email
 *      subtask), this assumption breaks and needs revisiting. A bounded 409
 *      retry is kept below as a safety net for a straggler from a previous
 *      run, NOT as a substitute for that.
 *
 * Because the agent is stateful, each triaged email appends a turn to its
 * conversation and the context grows across a run. The 180000-token window
 * on `letta/*` handles absorbs a normal morning's inbox comfortably; mdrag
 * lives with the same property on its shared agents.
 */

const LETTA_BASE_URL = (process.env.LETTA_BASE_URL ?? "https://api.letta.com").replace(/\/+$/, "");
const LETTA_API_KEY = process.env.LETTA_API_KEY ?? "";
const LETTA_AGENT_ID = process.env.LETTA_TRIAGE_AGENT_ID ?? "";
const LETTA_MODEL = process.env.LETTA_TRIAGE_MODEL ?? "letta/auto-fast";

const MAX_409_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const LETTA_TIMEOUT_MS = 120_000;

/**
 * True only when BOTH the key and a dedicated agent id are set.
 *
 * The caller uses this to decide between falling back and rethrowing the
 * original gateway error. Half-configured is treated as unconfigured on
 * purpose: an API key with no agent id cannot serve a request, and pretending
 * otherwise would turn a clear "gateway is down" into an opaque Letta 404.
 */
export function isLettaFallbackConfigured(): boolean {
  return LETTA_API_KEY !== "" && LETTA_AGENT_ID !== "";
}

type LettaMessage = {
  message_type?: string;
  content?: string | Array<{ text?: string }>;
};

/**
 * Send one message to the dedicated agent and return its assistant text.
 *
 * Concatenates every `assistant_message` in the response -- a Letta turn can
 * emit several (the agent may narrate before answering), and dropping all but
 * the first silently loses content.
 */
export async function lettaSend(message: string): Promise<string> {
  if (!isLettaFallbackConfigured()) {
    throw new Error(
      "Letta fallback is not configured — set LETTA_API_KEY and LETTA_TRIAGE_AGENT_ID"
    );
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_409_RETRIES; attempt++) {
    const res = await fetch(`${LETTA_BASE_URL}/v1/agents/${LETTA_AGENT_ID}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LETTA_API_KEY}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: message }],
        override_model: LETTA_MODEL,
      }),
      signal: AbortSignal.timeout(LETTA_TIMEOUT_MS),
    });

    if (res.status === 409 && attempt < MAX_409_RETRIES) {
      lastError = new Error(`Letta 409 (agent busy) on attempt ${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      // Surface the body: a 402 here means the agent is on a credit-billed
      // handle (see the module docstring), which is not obvious from the
      // status code alone.
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
    : new Error(`Letta agent ${LETTA_AGENT_ID} stayed busy after ${MAX_409_RETRIES} retries`);
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
 * Needed because the agent-messaging API has no schema enforcement (see the
 * module docstring) -- the reply is plain text that may be fenced, wrapped in
 * `<think>` blocks or tool-call tags, or embedded mid-sentence. Tries each
 * strategy in order and returns the first that parses to an object.
 *
 * Exported so `gateway-llm.ts` can use it on the gateway path too: qwen3.5-9b
 * emits the same wrappers, and the previous fence-only strip missed them.
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
