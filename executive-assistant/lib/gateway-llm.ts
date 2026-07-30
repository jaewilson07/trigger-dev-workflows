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

async function chat(messages: Array<{ role: string; content: string }>): Promise<string> {
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

function parseTriageContent(raw: string): TriageVerdict {
  let content = raw.trim();
  if (content.startsWith("```")) {
    content = content.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  }
  try {
    return JSON.parse(content) as TriageVerdict;
  } catch {
    return {
      category: "Internal",
      proposed_action: "keep",
      one_line_summary: content ? content.slice(0, 120) : "Unable to triage",
      confidence: 0,
    };
  }
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
