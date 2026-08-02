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

export type TriageInput = {
  sender: string;
  subject: string;
  snippet: string;
};

/**
 * Triage a whole inbox, preferring the local gateway and falling back to the
 * user's Letta agent.
 *
 * The two backends are driven DIFFERENTLY on purpose:
 *
 * - The gateway is stateless, so it stays one request per email. Small,
 *   independent prompts are what a 9B model handles best, and one malformed
 *   reply costs one verdict rather than the batch.
 * - Letta is one stateful conversation that replays its whole history every
 *   turn (measured: 52,344 prompt tokens for a 38-token answer), and it is
 *   the USER's agent, shared with every other surface. So the entire inbox
 *   goes in ONE message -- N turns would multiply that cost by N and write N
 *   machine-generated turns into their personal memory.
 *
 * The fallback decision is therefore made for the batch, not per email: once
 * the gateway has failed, retrying it for each remaining email would just
 * burn N timeouts before arriving at the same answer.
 *
 * Deliberately not silent: falling back swaps provider AND model mid-run, so
 * it logs a warning naming the gateway error that caused it. When Letta is
 * not configured the gateway's own error propagates untouched -- an
 * unconfigured fallback must not turn "gateway is down" into something vaguer.
 */
export async function triageEmailBatch(emails: TriageInput[]): Promise<TriageVerdict[]> {
  if (emails.length === 0) return [];
  try {
    const verdicts: TriageVerdict[] = [];
    for (const email of emails) {
      verdicts.push(await triageOneEmail(email));
    }
    return verdicts;
  } catch (gatewayError) {
    if (!isLettaFallbackConfigured()) throw gatewayError;
    logger.warn("gateway-llm: gateway unusable, falling back to the user's Letta agent", {
      gatewayUrl: GATEWAY_URL,
      emailCount: emails.length,
      error: gatewayError instanceof Error ? gatewayError.message : String(gatewayError),
    });
    return await triageViaLetta(emails);
  }
}

const LETTA_BATCH_INSTRUCTIONS = `Respond with ONLY a JSON object (no markdown fences, no prose) of the form:
{"verdicts": [{"index": <the email's index>, "category": ..., "proposed_action": ..., "one_line_summary": ..., "confidence": <0.0-1.0>}]}
Include exactly one entry per email, and echo each email's index so the verdicts can be matched back.`;

/**
 * One Letta turn for the whole inbox.
 *
 * Verdicts are matched back BY INDEX, not by array position: an agent that
 * drops or reorders an entry would otherwise silently attach email 3's
 * verdict to email 5, which is worse than no triage at all. Anything missing
 * degrades to a confidence-0 verdict and is logged.
 */
async function triageViaLetta(emails: TriageInput[]): Promise<TriageVerdict[]> {
  const listed = emails
    .map((e, i) => `[${i}]\nSender: ${e.sender}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`)
    .join("\n\n");
  // The agent's own system prompt belongs to the user and must not be
  // overwritten to specialise it for this surface, so the triage framing goes
  // in the user message instead.
  const reply = await lettaSend(
    `${TRIAGE_SYSTEM_PROMPT}\n\n${LETTA_BATCH_INSTRUCTIONS}\n\nTriage these ${emails.length} emails:\n\n${listed}`
  );

  const parsed = extractJson(reply);
  const rawVerdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : null;
  if (rawVerdicts === null) {
    logger.warn("gateway-llm: Letta reply had no verdicts array, degrading whole batch", {
      replyPreview: reply.trim().slice(0, 200),
    });
    return emails.map(() => degradedVerdict("Unable to triage"));
  }

  const byIndex = new Map<number, TriageVerdict>();
  for (const entry of rawVerdicts) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const index = typeof record.index === "number" ? record.index : null;
    const verdict = coerceVerdict(record);
    if (index !== null && verdict !== null) byIndex.set(index, verdict);
  }

  const missing: number[] = [];
  const result = emails.map((_, i) => {
    const verdict = byIndex.get(i);
    if (verdict === undefined) {
      missing.push(i);
      return degradedVerdict("Unable to triage");
    }
    return verdict;
  });
  if (missing.length > 0) {
    logger.warn("gateway-llm: Letta returned no usable verdict for some emails", {
      missingIndexes: missing,
      requested: emails.length,
      returned: rawVerdicts.length,
    });
  }
  return result;
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

/**
 * Shape-check a parsed object into a verdict, or null if it isn't one.
 *
 * Neither backend enforces the output schema, so a reply that parses as JSON
 * but answers a different question would otherwise put `undefined` into the
 * brief. `category` and `proposed_action` are the load-bearing fields; the
 * other two degrade to harmless defaults rather than rejecting the verdict.
 */
function coerceVerdict(parsed: Record<string, unknown>): TriageVerdict | null {
  if (typeof parsed.category !== "string" || !isTriageAction(parsed.proposed_action)) {
    return null;
  }
  return {
    category: parsed.category,
    proposed_action: parsed.proposed_action,
    one_line_summary: typeof parsed.one_line_summary === "string" ? parsed.one_line_summary : "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
  };
}

/** Confidence 0 is the downstream signal that triage did not really happen. */
function degradedVerdict(summary: string): TriageVerdict {
  return {
    category: "Internal",
    proposed_action: "keep",
    one_line_summary: summary,
    confidence: 0,
  };
}

function parseTriageContent(raw: string): TriageVerdict {
  // extractJson (not a bare JSON.parse on a fence-stripped string) because
  // the gateway ignores response schemas and qwen3.5-9b emits `<think>`
  // blocks and tool-call tags that the old fence-only strip left in place,
  // which parsed as a failure and degraded the verdict below.
  const parsed = extractJson(raw);
  const verdict = parsed === null ? null : coerceVerdict(parsed);
  if (verdict !== null) return verdict;

  // Degraded, but never silent: the warning is what makes a systematic parse
  // failure visible rather than showing up as a brief full of low-confidence
  // "keep" verdicts.
  const preview = raw.trim().slice(0, 120);
  logger.warn("gateway-llm: no parseable JSON in triage reply, degrading verdict", {
    replyPreview: preview,
  });
  return degradedVerdict(preview || "Unable to triage");
}

async function triageOneEmail(email: TriageInput): Promise<TriageVerdict> {
  const userPrompt = `Sender: ${email.sender}\nSubject: ${email.subject}\nSnippet: ${email.snippet}`;
  const content = await gatewayChat([
    { role: "system", content: TRIAGE_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);
  return parseTriageContent(content);
}
