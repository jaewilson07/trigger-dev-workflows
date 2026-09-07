/**
 * Authenticated, ephemeral-mode client for the generalized Letta gateway
 * (`infrastructure/bonker/apps/letta-shim`, Phase 2/3 of
 * `.agents/plans/two-gateway-llm-convergence.md`).
 *
 * Phase 4 replaces this project's direct-to-Letta-Cloud fallback
 * (`lib/letta-fallback.ts`'s `lettaSend`, which calls `api.letta.com`
 * straight from this Trigger.dev task) with a call through the shim: same
 * OpenAI-shaped `/v1/chat/completions` request, but with `ephemeral: true`
 * (Phase 3 — mints a throwaway conversation/agent per call, never reads or
 * writes the per-identity cache) and a `dc_` JWT instead of a caller-held
 * Letta API key. Neither this project nor its callers need `LETTA_API_KEY`
 * or a resolvable per-user agent name for this path — the shim owns that.
 *
 * `extractJson` (`lib/letta-fallback.ts`) still applies to whatever text
 * comes back: the shim's underlying model can emit `<think>` blocks and
 * tool-call tags same as before, that hasn't changed.
 */

import { resolveDatacrewToken } from "./datacrew-token.js";

// Internal-only service on bonker's `ai-network` (no public hostname, no
// Caddy route — see apps/letta-shim/docker-compose.yml's own header
// comment). Same container-DNS assumption as GATEWAY_URL in
// completion-gateway.ts: reachable by service name from wherever this
// project's Trigger.dev tasks actually run, not `localhost`.
const LETTA_GATEWAY_URL =
  process.env.LETTA_GATEWAY_URL ?? "http://letta-shim:8400/v1/chat/completions";
const LETTA_GATEWAY_MODEL = process.env.LETTA_GATEWAY_MODEL ?? "letta-alix";
const LETTA_GATEWAY_TIMEOUT_MS = 180_000; // matches letta-fallback.ts's LETTA_TIMEOUT_MS

export type LettaGatewayOptions = {
  model?: string;
};

/**
 * Send one ephemeral message through the letta gateway and return the
 * assistant's text. Every call gets its own fresh, discarded
 * conversation/agent (Phase 3) — this is a one-shot completion, not a turn
 * in a remembered conversation, matching how `lettaSend` was previously
 * used on this path (a whole system+user prompt sent as a single message).
 */
export async function completeViaLettaGateway(
  message: string,
  options?: LettaGatewayOptions
): Promise<string> {
  const token = resolveDatacrewToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(LETTA_GATEWAY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: options?.model ?? LETTA_GATEWAY_MODEL,
      messages: [{ role: "user", content: message }],
      ephemeral: true,
    }),
    signal: AbortSignal.timeout(LETTA_GATEWAY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Letta gateway error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message.content;
  if (content === undefined) {
    throw new Error(`Letta gateway returned no choices: ${JSON.stringify(data)}`);
  }
  return content;
}
