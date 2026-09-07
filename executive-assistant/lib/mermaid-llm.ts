/**
 * Stateless completion helper for the mermaid pipeline's classify/distill/
 * generate stages (datacrew-site#218) — completion-gateway-first, letta-
 * gateway-fallback, both authenticated with a `dc_` JWT (Phase 4 of
 * `.agents/plans/two-gateway-llm-convergence.md`).
 *
 * BEFORE PHASE 4: this called `GATEWAY_URL` with no auth at all and fell
 * back to the caller's own Letta Cloud agent directly (`lettaSend`,
 * `lib/letta-fallback.ts`) on failure. Both raw `fetch`s are gone now:
 * `completion-gateway.ts` and `letta-gateway.ts` wrap the same two
 * endpoints, attributed and — for the fallback path — ephemeral (Phase 3:
 * a throwaway conversation per call, never the user's own remembered
 * agent). The fallback reasoning is otherwise unchanged from before: the
 * completion gateway proxies to llama-swap on `cubby.lan`, which is
 * intentionally powered down much of the time, so the letta gateway
 * (independent infra) is the real fallback path, not an emergency one.
 * `extractJson` (`lib/letta-fallback.ts`) still applies to the fallback's
 * reply, for the same reason as before: qwen's `<think>` blocks and
 * tool-call tags survive a bare fence strip.
 */

import { logger } from "@trigger.dev/sdk";
import { completeViaGateway } from "./completion-gateway.js";
import { completeViaLettaGateway, isLettaGatewayConfigured } from "./letta-gateway.js";

export type LlmCallOptions = {
  /** Unused now that the fallback is the letta gateway's own ephemeral
   * identity rather than the caller's personal Letta agent — kept so
   * existing callers (mermaid-classify.ts, mermaid-distill.ts,
   * mermaid-render.ts) don't need a signature change for a Phase-4-internal
   * swap. */
  userEmail?: string;
  temperature?: number;
};

/**
 * One system+user completion, completion-gateway-first with a letta-gateway
 * (ephemeral) fallback. Returns the raw text — callers own their own parsing
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
    return await completeViaGateway(systemPrompt, userPrompt, {
      temperature: options?.temperature ?? 0.2,
    });
  } catch (gatewayError) {
    // Fail fast rather than waiting out the letta gateway's own timeout when
    // there is no credential to attach — same shape as the old
    // isLettaFallbackConfigured() guard this replaced (/code-review finding:
    // an unconditional fallback attempt turned a total-bonker outage into a
    // 180s hang instead of surfacing the gateway's own error immediately).
    if (!isLettaGatewayConfigured()) throw gatewayError;
    logger.warn("mermaid-llm: completion gateway unusable, falling back to the letta gateway (ephemeral)", {
      error: gatewayError instanceof Error ? gatewayError.message : String(gatewayError),
    });
    // A fresh, discarded conversation per call (Phase 3) — this fallback is
    // stateless from the caller's point of view, same as the gateway path
    // it's replacing. The system prompt is folded into the one message
    // since the letta gateway's chat-completions endpoint has no separate
    // "system" concept for an ephemeral call.
    return await completeViaLettaGateway(`${systemPrompt}\n\n${userPrompt}`);
  }
}
