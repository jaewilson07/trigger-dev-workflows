import { schedules, logger } from "@trigger.dev/sdk";
import { fetchEmails } from "./tasks/fetch-emails.js";
import { triageEmails } from "./tasks/triage-emails.js";
import { searchTopics } from "./tasks/search-topics.js";
import { synthesizeBrief } from "./tasks/synthesize-brief.js";
import { postSlack } from "./tasks/post-slack.js";
import { logActivity } from "./tasks/log-activity.js";

const MORNING_BRIEF_USER_ID = process.env.MORNING_BRIEF_USER_ID ?? "U08L4B485B4";
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
      userId: MORNING_BRIEF_USER_ID,
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
        text: briefMarkdown,
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
