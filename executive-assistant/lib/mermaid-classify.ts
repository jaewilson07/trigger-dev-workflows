/**
 * Stage 1 of the mermaid pipeline (datacrew-site#218): decide the graph type
 * BEFORE any distillation happens — the state object the user's original
 * design asked for. Everything downstream (which distill prompt, which
 * syntax rules, which render prompt) is routed off this single decision, so
 * getting it wrong here is worse than getting it wrong at any later stage.
 *
 * Deliberately a plain classification call, not a Letta conversation turn —
 * this needs to be cheap and fast (it may run before the user has typed a
 * full sentence, e.g. from a live STT batch), and it carries no identity or
 * memory that a Conversation would provide.
 */

import { logger } from "@trigger.dev/sdk";
import { completeText } from "./mermaid-llm.js";
import { extractJson } from "./letta-fallback.js";
import { isMermaidGraphType, type ClassifyResult, type MermaidGraphType } from "./mermaid-types.js";

const SYSTEM_PROMPT = `You classify what kind of Mermaid diagram a transcript or request describes. Respond with ONLY a JSON object (no markdown fences, no prose) of the form:
{"graph_type": "flowchart" | "sequence" | "erd", "confidence": <0.0-1.0>, "rationale": "<one sentence>"}

Definitions:
- "flowchart": a process, decision, or workflow — steps in order, with branches. Signal words: "then", "if", "steps", "process", "decide".
- "sequence": interactions between actors/systems over TIME — who sends what to whom, in order. Signal words: "calls", "sends", "responds", "requests", named actors talking to each other.
- "erd": entities/tables and how they relate — not a process. Signal words: "has many", "belongs to", entity names with attributes, "customers and orders".

If the transcript is genuinely ambiguous between two types, pick the one that best fits and lower confidence accordingly — never invent a fourth category.`;

/** Below this, the orchestrator blocks on human/agent disambiguation rather
 * than trusting the guess. Chosen conservatively — a wrong forced flowchart
 * default nobody notices, a wrong forced choice below this line usually
 * means the classifier said so itself ("could be either"). */
// (chosen conservatively rather than tuned against real data — revisit once
// the eval harness re-runs against this pipeline, per datacrew-site#218)
export const LOW_CONFIDENCE_THRESHOLD = 0.55;

const DEFAULT_GRAPH_TYPE: MermaidGraphType = "flowchart";

export async function classifyGraphType(transcript: string): Promise<ClassifyResult> {
  const reply = await completeText(SYSTEM_PROMPT, `Transcript / request:\n${transcript}`, {
    temperature: 0,
  });
  const parsed = extractJson(reply);
  const result = coerceClassifyResult(parsed);
  if (result) return result;

  logger.warn("mermaid-classify: no parseable classification, defaulting to flowchart", {
    replyPreview: reply.trim().slice(0, 200),
  });
  return {
    graph_type: DEFAULT_GRAPH_TYPE,
    confidence: 0,
    rationale: "Classifier reply was not parseable — defaulted to flowchart.",
  };
}

/** Exported for `mermaid-classify.test.ts` — pure shape-checking, no network. */
export function coerceClassifyResult(parsed: Record<string, unknown> | null): ClassifyResult | null {
  if (!parsed || !isMermaidGraphType(parsed.graph_type)) return null;
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  return {
    graph_type: parsed.graph_type,
    confidence: Math.max(0, Math.min(1, confidence)),
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
  };
}
