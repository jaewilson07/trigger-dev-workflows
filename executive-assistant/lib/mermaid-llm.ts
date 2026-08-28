/**
 * Stateless completion helper for the mermaid pipeline's classify/distill/
 * generate stages (datacrew-site#218) — gateway-first, Letta-fallback, same
 * split `lib/gateway-llm.ts` already uses for email triage.
 *
 * NOT a copy-paste of gateway-llm.ts's private `gatewayChat` — that function
 * isn't exported, and this pipeline's stages need a generic "system + user
 * -> raw text" call (JSON for classify/distill, fenced Mermaid text for
 * generate), not triage's fixed prompt/shape. The fallback reasoning is
 * identical, so it's restated here rather than linked: the gateway proxies to
 * llama-swap on `cubby.lan`, which is intentionally powered down much of the
 * time, so Letta Cloud (independent infra) is the real fallback path, not an
 * emergency one. Letta's own reply goes through `extractJson`
 * (`lib/letta-fallback.ts`) same as triage's Letta path, for the same reason:
 * qwen's `<think>` blocks and tool-call tags survive a bare fence strip.
 */

import { logger } from "@trigger.dev/sdk";
import { isLettaFallbackConfigured, lettaSend } from "./letta-fallback.js";

// Same env vars as gateway-llm.ts on purpose — one gateway, one model,
// shared across every stateless-completion caller in this project.
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://gateway:7630/v1/chat/completions";
const MODEL = process.env.GATEWAY_LLM_MODEL ?? "qwen3.5-9b";
const GATEWAY_TIMEOUT_MS = 60_000;

export type LlmCallOptions = {
  /** Passed straight to lettaSend's fallback — MORNING_BRIEF_USER_EMAIL by
   * default, same as every other stateless-completion caller in this
   * project. */
  userEmail?: string;
  temperature?: number;
};

/**
 * One system+user completion, gateway-first with a Letta-personal-agent
 * fallback. Returns the raw text — callers own their own parsing
 * (JSON extraction for classify/distill, fence extraction for generate).
 *
 * Deliberately does not batch or retry beyond the fallback swap: unlike
 * `triageEmailBatch`, every caller here is already one call for one unit of
 * work (one transcript, one spec) — there is no N-items-in-one-call
 * optimization to make.
 */
export async function completeText(
  systemPrompt: string,
  userPrompt: string,
  options?: LlmCallOptions
): Promise<string> {
  try {
    return await gatewayComplete(systemPrompt, userPrompt, options?.temperature ?? 0.2);
  } catch (gatewayError) {
    if (!isLettaFallbackConfigured()) throw gatewayError;
    logger.warn("mermaid-llm: gateway unusable, falling back to the user's Letta agent", {
      gatewayUrl: GATEWAY_URL,
      error: gatewayError instanceof Error ? gatewayError.message : String(gatewayError),
    });
    // The agent's own system prompt belongs to the user and must not be
    // overwritten — same reasoning as gateway-llm.ts's triageViaLetta.
    return await lettaSend(`${systemPrompt}\n\n${userPrompt}`, { userEmail: options?.userEmail });
  }
}

async function gatewayComplete(
  systemPrompt: string,
  userPrompt: string,
  temperature: number
): Promise<string> {
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature,
    }),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Gateway LLM error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message.content;
  if (content === undefined) {
    throw new Error(`Gateway LLM returned no choices: ${JSON.stringify(data)}`);
  }
  return content;
}
