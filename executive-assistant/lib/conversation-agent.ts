import { extractJson, isLettaFallbackConfigured, lettaSend } from "./letta-fallback.js";

export type ConversationAgentBackend = "auto" | "letta" | "claude";

export type ConversationAgentRequest = {
  systemPrompt: string;
  userPrompt: string;
  backend?: ConversationAgentBackend;
  /** Per-run model override from the admin platform setting. Falls back to
   * CLAUDE_MODEL, then to the Haiku default. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  lettaAgentId?: string;
  lettaUserEmail?: string;
};

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * Two ways to authenticate to Anthropic, and this fleet uses the second.
 *
 * A raw API key goes in `x-api-key`. An OAuth token — what Claude Code issues,
 * stored in Infisical as `CLAUDE_CODE_OAUTH_TOKEN` — is a bearer credential and
 * must go in `Authorization` instead; sending it as `x-api-key` is a 401.
 *
 * The key form wins when both are present, because it is the more specific
 * thing to have configured deliberately. `ANTHROPIC_AUTH_TOKEN` is accepted as
 * an alias since that is the name the Anthropic SDK itself uses for the bearer
 * form, and the alix bot already stores it under that name.
 */
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const CLAUDE_AUTH_TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";

/** The Anthropic auth header for whichever credential is configured. */
function claudeAuthHeader(): Record<string, string> {
  if (CLAUDE_API_KEY) return { "x-api-key": CLAUDE_API_KEY };
  return { Authorization: `Bearer ${CLAUDE_AUTH_TOKEN}` };
}
// Exact model ids only — these strings are complete as written and take no
// date suffix. Haiku 4.5 is the default because the interview is routing and
// extraction, not reasoning; the admin can raise it per-run.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";
const DEFAULT_BACKEND =
  (process.env.PATTERN_HUNTER_AGENT_BACKEND as ConversationAgentBackend | undefined) ?? "auto";

function isClaudeConfigured(): boolean {
  return CLAUDE_API_KEY !== "" || CLAUDE_AUTH_TOKEN !== "";
}

/**
 * Exported so callers can branch on the resolved backend BEFORE they act on
 * it — notably `pattern-hunter-interview.ts`, which checks `resolveBackend()`
 * before its planner/extraction rounds (which call `conversationAgentJson`,
 * itself built on `conversationAgentReply`) to decide whether an anonymous
 * caller even needs a Letta Conversation before it asks mdrag to create one
 * (ADR 0030 Addendum, point 3: Letta needs the Conversation at session start,
 * Claude doesn't need one until registration).
 */
export function resolveBackend(
  preferred?: ConversationAgentBackend
): Exclude<ConversationAgentBackend, "auto"> {
  const backend = preferred ?? DEFAULT_BACKEND;
  if (backend !== "auto") {
    return backend;
  }

  if (isClaudeConfigured()) return "claude";
  if (isLettaFallbackConfigured()) return "letta";

  throw new Error(
    "No conversation backend configured: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for Claude, or LETTA_API_KEY + MORNING_BRIEF_USER_EMAIL for Letta"
  );
}

async function sendViaClaude(request: ConversationAgentRequest): Promise<string> {
  if (!isClaudeConfigured()) {
    throw new Error(
      "Claude backend selected but no Anthropic credential is set (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)"
    );
  }

  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...claudeAuthHeader(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: request.model ?? CLAUDE_MODEL,
      max_tokens: request.maxTokens ?? 900,
      temperature: request.temperature ?? 0,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userPrompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = data.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(`Claude API returned no text content: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return text;
}

async function sendViaLetta(request: ConversationAgentRequest): Promise<string> {
  if (!isLettaFallbackConfigured()) {
    throw new Error("Letta backend selected but fallback settings are not configured");
  }

  return await lettaSend(`${request.systemPrompt}\n\n${request.userPrompt}`, {
    agentId: request.lettaAgentId,
    userEmail: request.lettaUserEmail,
  });
}

export async function conversationAgentReply(
  request: ConversationAgentRequest
): Promise<{ backend: Exclude<ConversationAgentBackend, "auto">; text: string }> {
  const backend = resolveBackend(request.backend);
  if (backend === "claude") {
    return { backend, text: await sendViaClaude(request) };
  }
  return { backend, text: await sendViaLetta(request) };
}

export async function conversationAgentJson<T>(
  request: ConversationAgentRequest
): Promise<{ backend: Exclude<ConversationAgentBackend, "auto">; value: T; raw: string }> {
  const withJsonInstructions: ConversationAgentRequest = {
    ...request,
    userPrompt:
      `${request.userPrompt}\n\n` +
      "Return ONLY valid JSON (no markdown fences, no prose, no commentary).",
    temperature: request.temperature ?? 0,
  };

  const result = await conversationAgentReply(withJsonInstructions);
  const parsed = extractJson(result.text);
  if (parsed === null) {
    throw new Error(`Agent did not return parseable JSON: ${result.text.slice(0, 300)}`);
  }
  return { backend: result.backend, value: parsed as T, raw: result.text };
}
