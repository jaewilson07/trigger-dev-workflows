import { logger } from "@trigger.dev/sdk";
import { extractJson, isLettaFallbackConfigured, lettaSend } from "./letta-fallback.js";

// Container DNS on ai-network, not localhost -- deployed tasks run in an
// isolated runner container, where localhost is the runner itself, not the
// gateway. Matches PATTERN_HUNTER_URL's own documented fix in .env.example.
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://gateway:7630/v1/chat/completions";
const MODEL = process.env.GATEWAY_LLM_MODEL ?? "qwen3.5-9b";

const TRIAGE_SYSTEM_PROMPT = `You are an email triage assistant. Given an email's sender, subject, and snippet, classify it and propose an action.

Categories: Client, Newsletter, Internal, Action Required, Personal, Notification, Spam.
Actions: archive, label, delete, keep.

Respond with ONLY a JSON object (no markdown fences) with keys:
category, proposed_action, one_line_summary, confidence (0.0-1.0).`;

export type TriageAction = "archive" | "label" | "delete" | "keep";

export type TriageVerdict = {
  category: string;
  proposed_action: TriageAction;
  one_line_summary: string;
  confidence: number;
};

/**
 * Try the local gateway; on ANY failure, fall back to Letta if it is
 * configured, else rethrow the gateway's own error unchanged.
 *
 * Deliberately not silent: the fallback swaps both provider and model
 * mid-run, so it logs a warning naming the gateway error that triggered it.
 * A brief that quietly came from a different model than usual is exactly the
 * kind of thing that should be visible in the run log. When Letta is not
 * configured, the original error propagates untouched -- an unconfigured
 * fallback must not turn "gateway is down" into a vaguer message.
 */
async function chat(messages: Array<{ role: string; content: string }>): Promise<string> {
  try {
    return await gatewayChat(messages);
  } catch (gatewayError) {
    if (!isLettaFallbackConfigured()) throw gatewayError;
    logger.warn("gateway-llm: gateway unreachable, falling back to Letta", {
      gatewayUrl: GATEWAY_URL,
      error: gatewayError instanceof Error ? gatewayError.message : String(gatewayError),
    });
    // The gateway takes an OpenAI-style message array; Letta's agent-messaging
    // API takes one user message, so flatten. Role labels are kept so the
    // system prompt still reads as instructions rather than as content.
    const flattened = messages
      .map((m) => (m.role === "user" ? m.content : `[${m.role}]\n${m.content}`))
      .join("\n\n");
    return await lettaSend(flattened);
  }
}

async function gatewayChat(messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.1 }),
    signal: AbortSignal.timeout(60_000),
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

const TRIAGE_ACTIONS: readonly string[] = ["archive", "label", "delete", "keep"];

function isTriageAction(value: unknown): value is TriageAction {
  return typeof value === "string" && TRIAGE_ACTIONS.includes(value);
}

function parseTriageContent(raw: string): TriageVerdict {
  // extractJson (not a bare JSON.parse on a fence-stripped string) because
  // neither backend enforces the output shape: the gateway ignores response
  // schemas, and Letta's agent-messaging API has none at all. Both emit
  // `<think>` blocks and tool-call tags that the old fence-only strip left in
  // place, which parsed as a failure and degraded the verdict below.
  const parsed = extractJson(raw);
  // Shape-check before trusting it. Neither backend enforces the schema, so a
  // reply that parses as JSON but answers a different question would
  // otherwise put `undefined` into the brief. Matters more on the Letta path,
  // which has no schema mechanism at all -- but the gateway can do it too.
  if (parsed !== null && typeof parsed.category === "string" && isTriageAction(parsed.proposed_action)) {
    return {
      category: parsed.category,
      proposed_action: parsed.proposed_action,
      one_line_summary: typeof parsed.one_line_summary === "string" ? parsed.one_line_summary : "",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
  }
  // Degraded, but never silent: confidence 0 is the signal downstream, and
  // the warning is what makes a systematic parse failure visible rather than
  // showing up as a brief full of low-confidence "keep" verdicts.
  const preview = raw.trim().slice(0, 120);
  logger.warn("gateway-llm: no parseable JSON in triage reply, degrading verdict", {
    replyPreview: preview,
  });
  return {
    category: "Internal",
    proposed_action: "keep",
    one_line_summary: preview || "Unable to triage",
    confidence: 0,
  };
}

export async function triageOneEmail(email: {
  sender: string;
  subject: string;
  snippet: string;
}): Promise<TriageVerdict> {
  const userPrompt = `Sender: ${email.sender}\nSubject: ${email.subject}\nSnippet: ${email.snippet}`;
  const content = await chat([
    { role: "system", content: TRIAGE_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);
  return parseTriageContent(content);
}
