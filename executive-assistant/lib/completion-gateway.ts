/**
 * Authenticated client for bonker's stateless completion gateway
 * (`gateway:7630`, Phase 0/1 of `.agents/plans/two-gateway-llm-convergence.md`).
 *
 * Phase 4 of that plan replaces every caller's raw, unauthenticated
 * `fetch(GATEWAY_URL, ...)` with this module: same request/response shape
 * (OpenAI-style `chat/completions`), now carrying a `dc_` JWT so the gateway
 * can attribute the call once `LLM_GATEWAY_REQUIRE_AUTH` flips to `true`
 * (`gateway/auth_datacrew.py`, `llm-gateway` scope). Today, with that flag
 * still `false`, the header is accepted but not required — sending it now
 * means no caller has to change again when it flips.
 */

import { resolveDatacrewToken } from "./datacrew-token.js";

// Same env vars every stateless-completion caller in this project has always
// used (mermaid-llm.ts, gateway-llm.ts) — one gateway, one model.
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://gateway:7630/v1/chat/completions";
const MODEL = process.env.GATEWAY_LLM_MODEL ?? "qwen3.5-9b";
const GATEWAY_TIMEOUT_MS = 60_000;

export type CompletionGatewayOptions = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

/**
 * One system+user completion via the shared completion gateway. Throws on
 * any non-2xx or malformed response — callers own their own fallback
 * decision (e.g. escalating to the letta gateway), this function never
 * swallows a failure.
 */
export async function completeViaGateway(
  systemPrompt: string,
  userPrompt: string,
  options?: CompletionGatewayOptions
): Promise<string> {
  const token = resolveDatacrewToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: options?.model ?? MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: options?.temperature ?? 0.2,
      ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
    }),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Completion gateway error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message.content;
  if (content === undefined) {
    throw new Error(`Completion gateway returned no choices: ${JSON.stringify(data)}`);
  }
  return content;
}
