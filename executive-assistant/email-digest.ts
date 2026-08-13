import { task, logger } from "@trigger.dev/sdk";
import { fetchEmails } from "./tasks/fetch-emails.js";
import type { EmailBatch } from "./tasks/fetch-emails.js";
import { triageEmails } from "./tasks/triage-emails.js";
import { synthesizeBrief } from "./tasks/synthesize-brief.js";
import { deliverSlackEphemeral } from "./tasks/deliver-slack-ephemeral.js";
import { emailDigestDeliver } from "./email-digest-deliver.js";

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
 * The digest itself is delivered via `email-digest-deliver.ts` — retrying
 * Slack `response_url` reply + optional Drive archive, in parallel, per
 * `docs/ADR-002-research-seam-delivery-composition.md`.
 * trigger-dev-workflows#54 found that split existed and typechecked but
 * this file still called a local, unretried inline `fetch` instead — the
 * exact defect `docs/email-digest-rework.md` documents fixing, never
 * actually landed.
 *
 * The two STATUS replies below (`not_connected`, `empty`) do NOT go through
 * `email-digest-deliver` — they are short strings with nothing to archive,
 * so they go straight to `deliver-slack-ephemeral` (the retrying primitive
 * `email-digest-deliver` itself uses), matching that task's own doc comment.
 * Only a real digest fans out.
 */

export type EmailDigestPayload = {
  userId: string;
  responseUrl: string;
  maxResults?: number;
};

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
        await deliverSlackEphemeral
          .triggerAndWait({
            responseUrl: payload.responseUrl,
            text: "Your Gmail connection was lost — run `/email-summary` again to reconnect.",
          })
          .unwrap();
        return { status: "not_connected" as const };
      }
      throw err;
    }

    if (emailBatch.count === 0) {
      await deliverSlackEphemeral
        .triggerAndWait({
          responseUrl: payload.responseUrl,
          text: "Your inbox is empty — nothing to summarize.",
        })
        .unwrap();
      return { status: "empty" as const };
    }

    const triageResults = await triageEmails.triggerAndWait({
      emails: emailBatch.emails,
    }).unwrap();

    const briefMarkdown = await synthesizeBrief.triggerAndWait({
      triageResults,
      topicResults: [],
    }).unwrap();

    const delivery = await emailDigestDeliver
      .triggerAndWait({
        userId: payload.userId,
        responseUrl: payload.responseUrl,
        briefMarkdown,
        emailCount: emailBatch.count,
      })
      .unwrap();

    logger.info("completed email-digest", {
      userId: payload.userId,
      emailCount: emailBatch.count,
      delivered: delivery.deliveredCount,
    });

    return { status: "ok" as const, emailCount: emailBatch.count, delivery };
  },
});
