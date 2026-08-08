import { logger, task } from "@trigger.dev/sdk";
import { conversationSend, isConversationSendConfigured } from "./lib/letta-conversations.js";
import type { Intake } from "./pattern-hunter-interview.js";

/**
 * Hand a finished Pattern Hunter interview to Letta and ask it to learn from it.
 *
 * This is what makes a Claude-backed session compatible with the Conversation
 * being the identity unit (ADR 0030, Addendum 2026-08-07, point 7). Claude
 * generates statelessly, so without this step the session's history exists only
 * in the visitor's browser and the Conversation that nominally owns their
 * identity stays empty.
 *
 * It is deliberately NOT a replay. The transcript goes over as one message with
 * an instruction attached — "here is a conversation I had with this user,
 * reflect on it and build their profile" — so the agent's job is to *learn*
 * from the session rather than to re-enact it. Replaying turn-by-turn would
 * fabricate an agent reply per turn and pay the full history cost N times
 * (ADR 0030 measured 52,344 prompt tokens for a single 38-token answer).
 */

export type ReflectTurn = { role: "agent" | "user"; text: string };

export type ReflectDiscovery = {
  headline: string;
  summary: string;
  source_url: string;
  source_name: string;
};

export type PatternHunterReflectPayload = {
  session_id: string;
  /** The Conversation this session belongs to — the identity link. Without it
   * the reflection would land on the shared agent unattributed. */
  conversation_id: string;
  intake: Intake;
  turns: ReflectTurn[];
  discoveries?: ReflectDiscovery[];
  /** Admin toggle (`ingest_to_letta`). A disabled run returns cleanly rather
   * than throwing — the caller shouldn't have to branch. */
  enabled?: boolean;
};

/** Render the session as Markdown. Readable on its own, because a human may
 * well end up reading this in the agent's history. */
function renderTranscript(payload: PatternHunterReflectPayload): string {
  const { intake, turns, discoveries } = payload;

  const brief = [
    `- **Company:** ${intake.subject ?? "not stated"}`,
    `- **Industry:** ${intake.industry ?? "not stated"}`,
    `- **Their role:** ${intake.role ?? "not stated"}`,
    `- **Biggest constraint:** ${intake.primary_constraint ?? "not stated"}`,
    intake.concerns?.length ? `- **Concerns:** ${intake.concerns.join(", ")}` : null,
    intake.focus_areas?.length ? `- **Focus areas:** ${intake.focus_areas.join(", ")}` : null,
    intake.risk_tolerance ? `- **Risk tolerance:** ${intake.risk_tolerance}` : null,
    intake.horizon_days ? `- **Horizon:** ${intake.horizon_days} days` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const conversation = turns
    .map((t) => `**${t.role === "user" ? "Operator" : "Pattern Hunter"}:** ${t.text}`)
    .join("\n\n");

  const found = discoveries?.length
    ? discoveries
        .map((d) => `- **${d.headline}** — ${d.summary} ([${d.source_name}](${d.source_url}))`)
        .join("\n")
    : "_None recorded._";

  return [
    `# Pattern Hunter interview — ${intake.subject ?? "unknown company"}`,
    "",
    "## The brief they gave",
    brief,
    "",
    "## The conversation",
    conversation,
    "",
    "## What the run discovered",
    found,
  ].join("\n");
}

/**
 * The instruction wrapped around the transcript.
 *
 * States plainly what the artifact is, that the Conversation belongs to this
 * one person, and what to do with it. The "don't reply to the operator" line
 * is load-bearing: without it the agent tends to answer the last question in
 * the transcript as though the conversation were still running.
 */
function buildReflectionPrompt(transcript: string, subject: string): string {
  return `I just finished running a Pattern Hunter interview with a user. The full session is below as Markdown.

This conversation is dedicated to this one user — it is where their history with us lives.

Read the session and build out (or update) a profile of this operator: what ${subject} does, what they are actually worried about, the constraint that is costing them now, how they make decisions, and what they would find valuable next. Note anything that contradicts what you already believed about them, and say what you changed rather than silently overwriting it.

Do not reply to the operator — the interview is over and they are not waiting on you. Your output is the profile.

---

${transcript}`;
}

export const patternHunterReflect = task({
  id: "pattern-hunter-reflect",
  retry: { maxAttempts: 2 },
  run: async (payload: PatternHunterReflectPayload) => {
    logger.info("pattern-hunter-reflect starting", {
      sessionId: payload.session_id,
      conversationId: payload.conversation_id,
      turns: payload.turns.length,
    });

    if (payload.enabled === false) {
      logger.info("pattern-hunter-reflect skipped — ingest_to_letta is off", {
        sessionId: payload.session_id,
      });
      return { written: false as const, reason: "disabled" as const };
    }

    if (!isConversationSendConfigured()) {
      // Loud rather than silent: a session whose history was supposed to be
      // recorded and wasn't is exactly the failure this step exists to prevent.
      throw new Error("Cannot write the session back: LETTA_API_KEY is not set");
    }
    if (!payload.conversation_id?.trim()) {
      throw new Error(
        "Cannot write the session back: no conversation_id. The Conversation is the identity unit (ADR 0030) — writing to the bare agent would attribute this session to nobody."
      );
    }

    const transcript = renderTranscript(payload);
    const prompt = buildReflectionPrompt(transcript, payload.intake.subject ?? "their company");

    logger.info("pattern-hunter-reflect writing session to Letta", {
      sessionId: payload.session_id,
      conversationId: payload.conversation_id,
      turns: payload.turns.length,
      transcriptChars: transcript.length,
    });

    const profile = await conversationSend(payload.conversation_id, prompt);

    logger.info("pattern-hunter-reflect completed — session written back to Letta", {
      sessionId: payload.session_id,
      conversationId: payload.conversation_id,
      transcriptChars: transcript.length,
    });

    return {
      written: true as const,
      conversation_id: payload.conversation_id,
      transcript_chars: transcript.length,
      profile,
    };
  },
});
