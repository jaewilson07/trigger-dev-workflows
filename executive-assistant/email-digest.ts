import { task, logger } from "@trigger.dev/sdk";
import { fetchEmails } from "./tasks/fetch-emails.js";
import type { EmailBatch } from "./tasks/fetch-emails.js";
import { triageEmails } from "./tasks/triage-emails.js";
import { synthesizeBrief } from "./tasks/synthesize-brief.js";

/**
 * On-demand, per-user inbox digest — triggered by Slack's `/email-summary`
 * (datacrew slackbot `commands/email_summary.py`), one run per invocation,
 * not the scheduled `morning-brief` cron.
 *
 * Each Slack user's Gmail token is stored independently, keyed by their own
 * `userId` (auth-service `slack:{userId}` convention — see
 * `lib/google-auth.ts`), so this task only ever reads and reports on the
 * INVOKING user's own inbox. No shared state between users.
 *
 * Replies via Slack's `response_url` (ephemeral, scoped to the invoking user
 * and interaction) rather than `post-slack.ts`'s `chat.postMessage` +
 * `DATACREW_SLACK_BOT_TOKEN`, which posts to a fixed channel for the
 * scheduled broadcast — a different delivery shape for a different use case.
 */

export type EmailDigestPayload = {
  userId: string;
  responseUrl: string;
  maxResults?: number;
};

async function respondEphemeral(responseUrl: string, text: string): Promise<void> {
  const res = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  });
  if (!res.ok) {
    throw new Error(`Slack response_url post failed: ${res.status} ${await res.text()}`);
  }
}

export const emailDigest = task({
  id: "email-digest",
  run: async (payload: EmailDigestPayload) => {
    logger.info("starting email-digest");
    let emailBatch: EmailBatch;
    try {
      // NOTE: `payload.userId` must already be a canonical EMAIL. This task is
      // invoked from a Slack slash command, so if that caller passes a Slack
      // user ID instead, auth-service 400s ("owner_email must be a valid email
      // address") -- the same way morning-brief did until 2026-08-02. Not
      // changed here because the payload shape is a cross-repo contract with
      // email_summary.py; resolving a Slack id to an email is infra-bonker#396.
      emailBatch = await fetchEmails.triggerAndWait({
        ownerEmail: payload.userId,
        maxResults: payload.maxResults ?? 25,
      }).unwrap();
    } catch (err) {
      // email_summary.py already checks the token exists before triggering
      // this task, but that check-then-trigger has a race window (token
      // revoked in between) -- fail with a helpful reply, not a raw error.
      if (err instanceof Error && err.message.includes("No Gmail token stored")) {
        await respondEphemeral(
          payload.responseUrl,
          "Your Gmail connection was lost — run `/email-summary` again to reconnect."
        );
        return { status: "not_connected" as const };
      }
      throw err;
    }

    if (emailBatch.count === 0) {
      await respondEphemeral(payload.responseUrl, "Your inbox is empty — nothing to summarize.");
      return { status: "empty" as const };
    }

    const triageResults = await triageEmails.triggerAndWait({
      emails: emailBatch.emails,
    }).unwrap();

    const briefMarkdown = await synthesizeBrief.triggerAndWait({
      triageResults,
      topicResults: [],
    }).unwrap();

    await respondEphemeral(payload.responseUrl, briefMarkdown);
    logger.info("Delivered on-demand email digest", { userId: payload.userId, emailCount: emailBatch.count });

    logger.info("completed email-digest");

    return { status: "ok" as const, emailCount: emailBatch.count };
  },
});
