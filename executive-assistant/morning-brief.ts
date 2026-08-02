import { schedules, logger } from "@trigger.dev/sdk";
import { fetchEmails } from "./tasks/fetch-emails.js";
import { triageEmails } from "./tasks/triage-emails.js";
import { searchTopics } from "./tasks/search-topics.js";
import { synthesizeBrief } from "./tasks/synthesize-brief.js";
import { postSlack } from "./tasks/post-slack.js";
import { buildBriefBlocks } from "./lib/slack-blocks.js";
import { logActivity } from "./tasks/log-activity.js";

/**
 * THREE identities for one person, and they are not interchangeable.
 *
 *   Slack       U08L4B485B4          (MORNING_BRIEF_USER_ID)
 *   Google      jae@datacrew.space   (MORNING_BRIEF_GOOGLE_OWNER_EMAIL)
 *   Letta/mdrag jaewilson07@gmail.com (MORNING_BRIEF_USER_EMAIL)
 *
 * auth-service keys `google_tokens` by `owner_email`, and for this person that
 * row is `jae@datacrew.space` -- its `account_email` is the gmail address, so
 * the gmail one looks right and returns "No Gmail token stored". Meanwhile
 * mdrag derives the Letta agent name from the GMAIL address
 * (mdrag_user_{sha256(email)[:12]}), so using the datacrew.space one there
 * resolves to an agent that does not exist.
 *
 * Passing the Slack id to Google auth is what broke this chain on its first
 * step (400: "owner_email must be a valid email address"); collapsing the two
 * email identities into one var is the same mistake one level down. Resolving
 * any of these to another is a separate blocked effort (infra-bonker#396), so
 * all three are carried explicitly.
 *
 * MORNING_BRIEF_USER_ID is deliberately not read here -- the brief is
 * addressed by MORNING_BRIEF_SLACK_CHANNEL, so nothing in this chain needs the
 * Slack id, and keeping it in scope only invites the mix-up again.
 */
const MORNING_BRIEF_GOOGLE_OWNER_EMAIL = process.env.MORNING_BRIEF_GOOGLE_OWNER_EMAIL ?? "";
const MORNING_BRIEF_SLACK_CHANNEL = process.env.MORNING_BRIEF_SLACK_CHANNEL ?? "";
const TRACKED_TOPICS = ["Domo acquisition", "Claude AI", "Snowflake Certification"];

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
  run: async () => {
    const emailBatch = await fetchEmails.triggerAndWait({
      ownerEmail: MORNING_BRIEF_GOOGLE_OWNER_EMAIL,
      maxResults: 25,
    }).unwrap();

    const triageResults = await triageEmails.triggerAndWait({
      emails: emailBatch.emails,
    }).unwrap();

    const topicResults = await searchTopics.triggerAndWait({
      topics: TRACKED_TOPICS,
      maxResultsPerTopic: 5,
    }).unwrap();

    const briefMarkdown = await synthesizeBrief.triggerAndWait({
      triageResults,
      topicResults,
    }).unwrap();

    let slackTs: string | null = null;
    if (MORNING_BRIEF_SLACK_CHANNEL) {
      const slackResult = await postSlack.triggerAndWait({
        channel: MORNING_BRIEF_SLACK_CHANNEL,
        // Markdown stays as the notification/accessibility fallback; the
        // rendered brief comes from blocks, since Slack does not speak
        // GitHub-flavored markdown (see lib/slack-blocks.ts).
        text: briefMarkdown,
        blocks: buildBriefBlocks(triageResults, topicResults),
      }).unwrap();
      slackTs = slackResult.ts;
    } else {
      logger.warn("MORNING_BRIEF_SLACK_CHANNEL not set — skipping Slack delivery");
    }

    // Fire-and-forget: don't block run completion on activity logging.
    await logActivity.trigger({
      date: new Date().toISOString().slice(0, 10),
      emailCount: emailBatch.count,
      topicCount: topicResults.length,
      slackTs,
      pipelineDurationMs: 0,
    });

    return {
      emailCount: emailBatch.count,
      triageCount: triageResults.length,
      topicCount: topicResults.length,
      slackTs,
    };
  },
});
