/**
 * Letta Cloud client for STORM research perspectives.
 *
 * STORM uses two existing Letta Cloud agents with distinct personas:
 *
 * - **EmmaBot** (`agent-5afcfa48-81d3-430f-87fe-0a814fecff7e`) — the public
 *   DUG Slack agent. Used for deep research perspectives (practitioner, academic,
 *   economist, historian, and any custom lenses). Has web_search + fetch_webpage
 *   tools.
 *
 * - **IdrisBot** (`agent-0604eb6c-85b1-46f9-9c13-fb147d85bf2a`) — the mentor/
 *   product developer. Used specifically as the SKEPTIC perspective. His
 *   persona is naturally critical and questioning — a good fit for STORM's
 *   adversarial lens. Has web_search + fetch_webpage tools.
 *
 * WHY EXISTING AGENTS INSTEAD OF A NEW DEDICATED AGENT: Jae's direction —
 * the existing agents already have distinct personas, memory, and tool
 * access. IdrisBot's persona is naturally skeptical, making him a better
 * skeptic than a prompt-injected lens on a generic agent. EmmaBot's community
 * knowledge makes her a strong deep researcher.
 *
 * CONCURRENCY: Multiple perspectives messaging EmmaBot in parallel will 409
 * each other (one stateful conversation). The 409 retry with backoff handles
 * this — perspectives wait their turn. IdrisBot (skeptic) runs independently
 * since it's a different agent, so at least 2 perspectives can truly run in
 * parallel.
 *
 * SHARED HISTORY TRADEOFF: All EmmaBot perspectives share one conversation
 * history, so later perspectives can see earlier ones' research. This is
 * sometimes a feature (cross-perspective awareness) and sometimes a bias
 * risk. Acceptable for now; switch to Conversations API if isolation becomes
 * important.
 */

import { logger } from "@trigger.dev/sdk";

const LETTA_BASE_URL = (process.env.LETTA_BASE_URL ?? "https://api.letta.com").replace(/\/+$/, "");
const LETTA_API_KEY = process.env.LETTA_API_KEY ?? "";
const LETTA_MODEL = process.env.LETTA_MODEL ?? "letta/auto-fast";

const MAX_409_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const LETTA_TIMEOUT_MS = 180_000;

/**
 * Agent IDs on Letta Cloud.
 *
 * These are the existing DataCrew multi-agent fleet — not new agents created
 * for STORM. See the system memory's "Letta Cloud Agents" section for full
 * details on each agent's persona and tools.
 */
export const EMMABOT_AGENT_ID = "agent-5afcfa48-81d3-430f-87fe-0a814fecff7e";
export const IDRISBOT_AGENT_ID = "agent-0604eb6c-85b1-46f9-9c13-fb147d85bf2a";

/**
 * Map a STORM perspective lens to the appropriate Letta Cloud agent.
 *
 * The skeptic lens uses IdrisBot — his persona is naturally critical and
 * questioning, making him a better skeptic than a prompt-injected lens.
 * Everything else uses EmmaBot for deep research.
 */
export function agentIdForLens(lens: string): string {
  if (lens === "skeptic") {
    return IDRISBOT_AGENT_ID;
  }
  return EMMABOT_AGENT_ID;
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${LETTA_API_KEY}`,
  };
}

type LettaMessage = {
  message_type?: string;
  content?: string | Array<{ text?: string }>;
};

/**
 * Send a message to a specific Letta Cloud agent and return its assistant text.
 *
 * The `perspectivePrompt` is injected into the user message (not the system
 * prompt — the agent's own persona stays intact). The `agentId` selects which
 * agent to message (EmmaBot for research, IdrisBot for skeptic).
 */
export async function lettaResearch(
  agentId: string,
  perspectivePrompt: string,
  researchQuestion: string
): Promise<string> {
  if (!LETTA_API_KEY) {
    throw new Error("LETTA_API_KEY is not set — cannot reach Letta Cloud");
  }

  const headers = authHeaders();

  // Combine the perspective prompt and research question into one user message.
  const message = `${perspectivePrompt}\n\n---\n\nResearch question: ${researchQuestion}\n\nUse your web search and web fetch tools to find grounded, cited answers. For each claim, include the source URL and source name. If you cannot find a source, mark the claim as unverified. Format your findings as a JSON array of objects with keys: claim, source, sourceName, verified.`;

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
      // Another surface (Slack, mermaid, another STORM perspective) is mid-turn
      // on this same agent. Back off and retry.
      lastError = new Error(`Letta 409 (agent busy) on attempt ${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
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

// --- JSON extraction (ported from letta-fallback.ts) ---

const FENCE_RE = /^```(?:\w+)?\s*\n|\n```\s*$/gm;
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;
const TOOL_CALL_TAG_RE = /<\/?tool_call>|<\/?tool_response>|\[\/?TOOL_CALLS\]/gi;
const JSON_ARRAY_RE = /\[[\s\S]*\]/;
const JSON_OBJECT_RE = /\{[\s\S]*\}/;

/**
 * Best-effort extraction of a JSON array or object from an LLM's prose reply.
 * Ported from `letta-fallback.ts`'s `extractJson`, extended to handle arrays.
 */
export function extractJson(text: string): unknown | null {
  const stripped = text.replace(FENCE_RE, "").trim();
  const cleaned = stripped.replace(THINK_BLOCK_RE, "").replace(TOOL_CALL_TAG_RE, "").trim();

  const candidates: string[] = [stripped];
  if (cleaned !== stripped) candidates.push(cleaned);

  // Try array first (STORM findings are arrays), then object.
  for (const source of [cleaned, stripped]) {
    const arrayMatch = source.match(JSON_ARRAY_RE);
    if (arrayMatch) {
      candidates.push(arrayMatch[0]);
      break;
    }
    const objMatch = source.match(JSON_OBJECT_RE);
    if (objMatch) {
      candidates.push(objMatch[0]);
      break;
    }
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next strategy
    }
  }
  return null;
}

/**
 * Parse findings from the agent's reply.
 *
 * The agent is asked to return a JSON array of findings, but LLM output is
 * unpredictable — it might wrap in fences, add prose, or nest in an object.
 * This function tries every strategy and degrades to raw text if nothing parses.
 */
export function parseFindings(
  reply: string,
  perspectiveLens: string
): Array<{ claim: string; source: string; sourceName: string; verified: boolean }> {
  const parsed = extractJson(reply);
  let rawFindings: unknown[] | null = null;

  if (Array.isArray(parsed)) {
    rawFindings = parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.findings)) rawFindings = obj.findings;
    else if (Array.isArray(obj.results)) rawFindings = obj.results;
  }

  if (!rawFindings) {
    logger.warn("letta-storm: no parseable findings array in reply, using raw text", {
      replyPreview: reply.trim().slice(0, 200),
    });
    return [
      {
        claim: reply.trim().slice(0, 500),
        source: "",
        sourceName: "",
        verified: false,
      },
    ];
  }

  return rawFindings
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .map((f) => ({
      claim: typeof f.claim === "string" ? f.claim : String(f.claim ?? ""),
      source: typeof f.source === "string" ? f.source : typeof f.url === "string" ? f.url : "",
      sourceName:
        typeof f.sourceName === "string"
          ? f.sourceName
          : typeof f.source_name === "string"
            ? f.source_name
            : typeof f.name === "string"
              ? f.name
              : "",
      verified: typeof f.verified === "boolean" ? f.verified : false,
    }))
    .filter((f) => f.claim.length > 0);
}
