/**
 * Stage 3 of the mermaid pipeline (datacrew-site#218): a clean,
 * mechanical "spec -> Mermaid syntax" conversion. By the time this runs,
 * graph_type is settled and the spec is already structured — this stage's
 * only job is rendering it correctly, which is exactly the narrow task
 * prompt-level syntax rules (`mermaid-syntax-rules.ts`) measurably help
 * with.
 *
 * Two escalation tiers, matching the "Letta steered workflow" half of the
 * original ask:
 *  1. Stateless gateway/Letta-personal-agent completion (mermaid-llm.ts) —
 *     cheap, used for every attempt including retries-with-feedback.
 *  2. If every stateless attempt still fails validation AND the caller
 *     passed a `conversationId` (the user's live mermaid Conversation), one
 *     final attempt goes through `conversationSend` instead — the same
 *     Letta agent the user has been steering all along gets the validator's
 *     own error message and is asked to fix it. This is the "the
 *     conversation with an agent" half of the two-stage design finally
 *     doing real work, not just holding chat history: it's what
 *     `conversationId` on the pipeline payload is FOR.
 */

import { conversationSend } from "./letta-conversations.js";
import { completeText } from "./mermaid-llm.js";
import { syntaxRulesForType } from "./mermaid-syntax-rules.js";
import type { DiagramSpec, MermaidGraphType } from "./mermaid-types.js";

const SYSTEM_PROMPT_PREFIX =
  "Convert the following structured specification into valid Mermaid syntax. " +
  "Respond with ONLY a ```mermaid fenced code block — no prose before or after it.";

const FENCE_RE = /```(?:mermaid)?\s*\n([\s\S]*?)```/;

export function extractMermaidBlock(text: string): string | null {
  const match = text.match(FENCE_RE);
  return match?.[1]?.trim() || null;
}

function buildPrompt(graphType: MermaidGraphType, spec: DiagramSpec, priorError?: string): string {
  const parts = [
    SYSTEM_PROMPT_PREFIX,
    syntaxRulesForType(graphType),
    `Specification:\n${JSON.stringify(spec, null, 2)}`,
  ];
  if (priorError) {
    parts.push(
      `Your previous attempt failed to parse with this error — fix it, don't just repeat the same output:\n${priorError}`
    );
  }
  return parts.join("\n\n");
}

/** Stateless attempt — gateway-first with Letta-personal-agent fallback. */
export async function renderStateless(
  graphType: MermaidGraphType,
  spec: DiagramSpec,
  priorError?: string
): Promise<string> {
  const prompt = buildPrompt(graphType, spec, priorError);
  const reply = await completeText("You render Mermaid diagrams from structured specs.", prompt, {
    temperature: priorError ? 0.4 : 0.1, // nudge harder off a repeated failure
  });
  const diagram = extractMermaidBlock(reply);
  if (!diagram) {
    throw new Error(`Render stage got no fenced Mermaid block back: ${reply.trim().slice(0, 200)}`);
  }
  return diagram;
}

/**
 * Escalation tier — asks the user's own live mermaid Conversation to fix a
 * diagram that survived every stateless retry. Only called when a
 * `conversationId` is actually available; the orchestrator decides that,
 * not this function.
 */
export async function renderViaConversation(
  conversationId: string,
  graphType: MermaidGraphType,
  spec: DiagramSpec,
  priorError: string
): Promise<string> {
  const prompt = buildPrompt(graphType, spec, priorError);
  const reply = await conversationSend(
    conversationId,
    `${prompt}\n\nEvery automated attempt at this diagram has failed to parse — please fix it directly.`
  );
  const diagram = extractMermaidBlock(reply);
  if (!diagram) {
    throw new Error(
      `Conversation escalation got no fenced Mermaid block back: ${reply.trim().slice(0, 200)}`
    );
  }
  return diagram;
}
