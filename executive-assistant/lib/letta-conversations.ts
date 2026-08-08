/**
 * Conversation-scoped Letta sends.
 *
 * `lettaSend` (letta-fallback.ts) posts to `/v1/agents/{id}/messages`, which is
 * agent-scoped — fine for a one-off question, wrong when the Conversation is
 * what carries identity (ADR 0030, Addendum 2026-08-07). This posts to
 * `/v1/conversations/{id}/messages` instead, the same endpoint
 * `cboti/letta/multi_agent_relay.py:155` uses via the Python client's
 * `client.conversations.messages.create(conversation_id, ...)`.
 *
 * WHY THIS ISN'T A TRANSCRIPT REPLAY. The obvious-looking approach — post each
 * turn of a finished conversation back in order — is wrong twice over: the
 * endpoint *generates a reply* per message, so replaying N turns fabricates N
 * new agent replies that never happened; and ADR 0030's own measurements
 * (2026-08-01: 52,344 prompt tokens for a 38-token answer) show an agent
 * replays its whole history every turn, so N turns cost N times that. One
 * message carrying the whole transcript, with an instruction about what to do
 * with it, is both cheaper and the only version that records what happened.
 */

const LETTA_BASE_URL = (process.env.LETTA_BASE_URL ?? "https://api.letta.com").replace(/\/+$/, "");
const LETTA_API_KEY = process.env.LETTA_API_KEY ?? "";
const LETTA_MODEL = process.env.LETTA_TRIAGE_MODEL ?? "letta/auto-fast";

const MAX_409_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const LETTA_TIMEOUT_MS = 180_000;

export function isConversationSendConfigured(): boolean {
  return LETTA_API_KEY !== "";
}

/**
 * Post one message to a Conversation and return the agent's reply text.
 *
 * Retries 409 the same way `lettaSend` does: the shared agent is one stateful
 * lane, so a concurrent surface mid-turn is expected rather than exceptional.
 */
export async function conversationSend(
  conversationId: string,
  message: string
): Promise<string> {
  if (!isConversationSendConfigured()) {
    throw new Error("Letta is not configured — set LETTA_API_KEY");
  }
  if (!conversationId.trim()) {
    throw new Error("conversationId is required — an agent-scoped send loses the identity link");
  }

  const headers = {
    Authorization: `Bearer ${LETTA_API_KEY}`,
    "Content-Type": "application/json",
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_409_RETRIES; attempt++) {
    const res = await fetch(`${LETTA_BASE_URL}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: message }],
        override_model: LETTA_MODEL,
      }),
      signal: AbortSignal.timeout(LETTA_TIMEOUT_MS),
    });

    if (res.status === 409 && attempt < MAX_409_RETRIES) {
      lastError = new Error(`Letta 409 (conversation busy) on attempt ${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      // Surface the body — a 402 means the request landed on a credit-billed
      // handle, which the status code alone does not say.
      throw new Error(`Letta error: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as {
      messages?: Array<{ message_type?: string; content?: unknown }>;
    };

    // Only assistant_message carries the reply; reasoning and tool messages
    // share the array and would otherwise be concatenated into the output.
    const reply = (body.messages ?? [])
      .filter((m) => m.message_type === "assistant_message")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n")
      .trim();

    return reply;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Letta conversation ${conversationId} stayed busy after ${MAX_409_RETRIES} retries`);
}
