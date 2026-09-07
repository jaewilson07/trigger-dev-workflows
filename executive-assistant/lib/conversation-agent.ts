import { extractJson } from "./letta-fallback.js";
import { completeViaGateway } from "./completion-gateway.js";
import { completeViaLettaGateway } from "./letta-gateway.js";

export type ConversationAgentBackend = "auto" | "letta" | "claude";

export type ConversationAgentRequest = {
  systemPrompt: string;
  userPrompt: string;
  backend?: ConversationAgentBackend;
  /** Per-run model override from the admin platform setting. Ignored for the
   * `claude` case now that it's routed through the completion gateway
   * (Phase 4 of two-gateway-llm-convergence.md) — the gateway's own config
   * picks the backend model, not the caller. Kept on the request type since
   * `pattern-hunter-interview.ts` still passes it through. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  lettaAgentId?: string;
  lettaUserEmail?: string;
};

// Exact model ids only — these strings are complete as written and take no
// date suffix. Haiku 4.5 was the default because the interview is routing
// and extraction, not reasoning — now moot for the `claude` case (see the
// `model` field's comment above), kept only as the DEFAULT_BACKEND doc
// reference below.
const DEFAULT_BACKEND =
  (process.env.PATTERN_HUNTER_AGENT_BACKEND as ConversationAgentBackend | undefined) ?? "auto";

/**
 * Exported so callers can branch on the resolved backend BEFORE they act on
 * it — notably `pattern-hunter-interview.ts`, which checks `resolveBackend()`
 * before its planner/extraction rounds (which call `conversationAgentJson`,
 * itself built on `conversationAgentReply`) to decide whether an anonymous
 * caller even needs a Letta Conversation before it asks mdrag to create one
 * (ADR 0030 Addendum, point 3: Letta needs the Conversation at session start,
 * Claude doesn't need one until registration).
 *
 * BEFORE PHASE 4 (two-gateway-llm-convergence.md): `auto` picked whichever
 * of Claude/Letta had its own direct credential configured
 * (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`, or `LETTA_API_KEY` +
 * `MORNING_BRIEF_USER_EMAIL`). Both cases now go through the same `dc_`-JWT-
 * authenticated gateways every other stateless/ephemeral caller in this
 * project uses, so there is nothing left to probe — `auto` always resolves
 * to `claude` (the completion gateway) unless explicitly overridden.
 */
export function resolveBackend(
  preferred?: ConversationAgentBackend
): Exclude<ConversationAgentBackend, "auto"> {
  const backend = preferred ?? DEFAULT_BACKEND;
  return backend === "auto" ? "claude" : backend;
}

async function sendViaClaude(request: ConversationAgentRequest): Promise<string> {
  return await completeViaGateway(request.systemPrompt, request.userPrompt, {
    temperature: request.temperature ?? 0,
    maxTokens: request.maxTokens ?? 900,
  });
}

async function sendViaLetta(request: ConversationAgentRequest): Promise<string> {
  // Ephemeral (Phase 3): a fresh, discarded conversation per turn, not the
  // caller-supplied `lettaAgentId`/`lettaUserEmail` from the pre-Phase-4
  // direct-Letta-Cloud path — the letta gateway owns identity/conversation
  // resolution now. Both fields are kept on the request type only because
  // `pattern-hunter-interview.ts` still passes them through.
  return await completeViaLettaGateway(`${request.systemPrompt}\n\n${request.userPrompt}`);
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
