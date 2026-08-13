import { schedules, logger } from "@trigger.dev/sdk";
import { briefResearch } from "./brief-research.js";
import { briefDeliver } from "./brief-deliver.js";
import { deliveredTo } from "./lib/brief-delivery.js";
import { logActivity } from "./tasks/log-activity.js";

/**
 * The entry point for the daily brief: research -> deliver.
 *
 * This is a THIN SEQUENCER, per
 * `docs/ADR-002-research-seam-delivery-composition.md` -- the fetch/triage/
 * search chain lives in `brief-research.ts` and the synthesize + four-way
 * fan-out lives in `brief-deliver.ts`. This file used to inline both halves
 * (and, before that, do everything itself); trigger-dev-workflows#54 found
 * that the split existed and typechecked but nothing actually called it, so
 * the daily brief had been Slack-only in production despite
 * `executive-assistant/docs/morning-brief-rework.md` documenting Domo/
 * Google Doc/Notion delivery as shipped.
 *
 * THREE identities for one person, and they are not interchangeable --
 * still true, now split across the two halves this file sequences:
 *
 *   Slack       U08L4B485B4          (MORNING_BRIEF_USER_ID, unused here)
 *   Google      jae@datacrew.space   (MORNING_BRIEF_GOOGLE_OWNER_EMAIL, read by brief-research.ts)
 *   Letta/mdrag jaewilson07@gmail.com (MORNING_BRIEF_USER_EMAIL, unused here)
 *
 * auth-service keys `google_tokens` by `owner_email`, and for this person
 * that row is `jae@datacrew.space` -- its `account_email` is the gmail
 * address, so the gmail one looks right and returns "No Gmail token
 * stored". Meanwhile mdrag derives the Letta agent name from the GMAIL
 * address (mdrag_user_{sha256(email)[:12]}), so using the datacrew.space
 * one there resolves to an agent that does not exist. Passing the Slack id
 * to Google auth is what broke this chain on its first step once already
 * (400: "owner_email must be a valid email address"); collapsing the two
 * email identities into one var is the same mistake one level down. See
 * `brief-research.ts`'s own doc comment for where MORNING_BRIEF_GOOGLE_
 * OWNER_EMAIL is actually read now.
 *
 * MORNING_BRIEF_USER_ID is deliberately not read anywhere in this chain --
 * the brief is addressed by MORNING_BRIEF_SLACK_CHANNEL (read by
 * `tasks/deliver-slack.ts`), so nothing needs the Slack id, and keeping it
 * in scope only invites the mix-up again.
 */
export const morningBrief = schedules.task({
  id: "morning-brief",
  cron: {
    pattern: "0 7 * * *",
    timezone: "America/Denver",
  },
  ttl: "10m",
  queue: {
    concurrencyLimit: 1,
  },
  // The orchestrator itself does not retry -- research and deliver each
  // retry independently. Re-running the whole thing would re-fetch mail and
  // re-post to every destination for no benefit.
  retry: { maxAttempts: 1 },
  run: async () => {
    logger.info("starting morning-brief");

    // --- Research half ---
    const research = await briefResearch.triggerAndWait({}).unwrap();

    // --- Delivery half ---
    const delivery = await briefDeliver.triggerAndWait({ research }).unwrap();

    const slackTs = deliveredTo(delivery.deliveries, "slack")?.ts ?? null;

    // Fire-and-forget: don't block run completion on activity logging.
    await logActivity.trigger({
      date: research.date,
      emailCount: research.emailCount,
      topicCount: research.topicResults.length,
      slackTs,
      pipelineDurationMs: 0,
    });

    logger.info("completed morning-brief", {
      emailCount: research.emailCount,
      triageCount: research.triageResults.length,
      topicCount: research.topicResults.length,
      delivered: delivery.deliveredCount,
      skipped: delivery.skippedCount,
      failed: delivery.failedCount,
    });

    return {
      emailCount: research.emailCount,
      triageCount: research.triageResults.length,
      topicCount: research.topicResults.length,
      slackTs,
      delivery,
    };
  },
});
