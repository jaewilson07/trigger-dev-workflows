import { task, logger } from "@trigger.dev/sdk";
import type { StormBriefingWithMarkdown, OutputResult } from "../lib/storm-types.js";

export type OutputSlackBriefingPayload = {
  briefing: StormBriefingWithMarkdown;
  /** Slack channel ID, or "user:U123..." to DM that user. */
  slackChannel: string;
};

/**
 * output-slack-briefing — posts the plain-text briefing summary to Slack.
 *
 * One of the pluggable output destinations the parent orchestrator fans out
 * to after prepare-report. Never throws: a delivery failure is reported as
 * `success: false` so one bad destination can't sink the others.
 */
export const outputSlackBriefing = task({
  id: "output-slack-briefing",
  retry: { maxAttempts: 1 },
  run: async (payload: OutputSlackBriefingPayload): Promise<OutputResult> => {
    const { briefing, slackChannel } = payload;

    try {
      await postToSlack(slackChannel, briefing.summary);
      logger.info("output-slack-briefing: posted summary", { channel: slackChannel });
      return { destination: "slack_briefing", success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn("output-slack-briefing: Slack post failed", { error });
      return { destination: "slack_briefing", success: false, error };
    }
  },
});

async function postToSlack(channel: string, message: string): Promise<void> {
  const token = process.env.DATACREW_SLACK_BOT_TOKEN ?? "";
  if (!token) {
    throw new Error("DATACREW_SLACK_BOT_TOKEN not set");
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel: normalizeChannel(channel),
      text: message,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Slack API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API returned error: ${data.error ?? "unknown"}`);
  }
}

/**
 * Callers address DMs as "user:U123..." (the DataCrew convention). Slack's API
 * wants the bare user ID — passing it as `channel` opens/reuses the DM.
 */
function normalizeChannel(channel: string): string {
  return channel.startsWith("user:") ? channel.slice("user:".length) : channel;
}
