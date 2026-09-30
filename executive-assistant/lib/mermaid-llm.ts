/**
 * Completion helper for the mermaid pipeline's classify/distill/render
 * stages. Every call is one turn to a Letta agent through a Letta Code channel
 * (`lib/letta-channel.ts`, the wiki-stream bridge) — NOT the completion
 * gateway's `/v1/chat/completions`, and not the letta-shim's ephemeral
 * completion either (ADR-057; direction from mdrag#1640).
 *
 * There is deliberately no fallback to a direct LLM path. If the channel is
 * down, unconfigured, or the turn fails, the error propagates and the
 * pipeline run fails visibly.
 *
 * The agent is whichever one the channel account is bound to (EmmaBot for
 * datacrew); this module names no agent. There is no mermaid persona: the
 * task framing rides in the message, as #1640 requires, folded as
 * system + user text because a channel turn has a single text field.
 *
 * `extractJson` (`lib/letta-fallback.ts`) still applies to the reply:
 * callers own their own parsing, and an agent may wrap JSON in prose.
 */

import { randomUUID } from "node:crypto";
import { logger } from "@trigger.dev/sdk";
import { completeViaLettaChannel, type LettaChannelConfig } from "./letta-channel.js";

export type LlmCallOptions = {
  /** Forwarded to the channel only when the caller has a real identity. */
  userEmail?: string;
  /** Kept for caller compatibility; an agent turn has no temperature knob. */
  temperature?: number;
  /**
   * Letta conversation to run in. Defaults to a fresh one per call, so the
   * independent classify/distill/render prompts never see each other.
   */
  conversationKey?: string;
  /** Test seam; production reads the env-configured bridge. */
  channel?: LettaChannelConfig;
};

export async function completeText(
  systemPrompt: string,
  userPrompt: string,
  options?: LlmCallOptions
): Promise<string> {
  const conversationKey = options?.conversationKey ?? `mermaid:${randomUUID()}`;
  logger.info("mermaid-llm: turn via letta channel", { conversationKey });
  return await completeViaLettaChannel(
    {
      conversationKey,
      text: `${systemPrompt}\n\n${userPrompt}`,
      email: options?.userEmail,
    },
    options?.channel
  );
}
