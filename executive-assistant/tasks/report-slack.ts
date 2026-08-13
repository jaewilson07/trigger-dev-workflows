import { task, logger } from "@trigger.dev/sdk";
import { postSlack } from "./post-slack.js";
import { buildReportBlocks } from "../lib/render-report.js";
import { reportSkipped, type ReportDeliveryBase, type ReportOutcome } from "../lib/report-delivery.js";

/**
 * Slack delivery for a research report.
 *
 * A THIN ADAPTER OVER `post-slack`, exactly like `deliver-slack.ts` is for the
 * brief: `post-slack` stays the one generic Slack primitive (channel/text/
 * blocks, block-boundary chunking, 3 retries, per-block error detail) and this
 * file holds the one report-specific decision — that a report renders as Block
 * Kit built from `steps[]`, with the markdown as the notification/accessibility
 * fallback (see `lib/render-report.ts` for why both formats exist).
 *
 * This is the third caller of `post-slack` and adds no fourth Slack HTTP
 * implementation, which is the duplication the composition audit flagged.
 */
export type ReportSlackPayload = ReportDeliveryBase & {
  /** Defaults to REPORT_SLACK_CHANNEL, then MORNING_BRIEF_SLACK_CHANNEL. */
  channel?: string;
};

export const reportSlack = task({
  id: "report-slack",
  // No retry here: `post-slack` already retries the HTTP call 3x, and a retry
  // at this level would repost a report that had partially succeeded.
  run: async (payload: ReportSlackPayload): Promise<ReportOutcome> => {
    logger.info("starting report-slack");
    if (payload.enabled === false) {
      return reportSkipped("slack", "disabled by caller");
    }

    const channel =
      payload.channel ?? process.env.REPORT_SLACK_CHANNEL ?? process.env.MORNING_BRIEF_SLACK_CHANNEL ?? "";
    if (!channel) {
      return reportSkipped(
        "slack",
        "no channel in payload and neither REPORT_SLACK_CHANNEL nor MORNING_BRIEF_SLACK_CHANNEL is set"
      );
    }

    const result = await postSlack
      .triggerAndWait({
        channel,
        text: payload.markdown,
        blocks: buildReportBlocks(payload.report),
      })
      .unwrap();

    logger.info("completed report-slack", { channel: result.channel, messageCount: result.messageCount });

    return {
      destination: "slack",
      status: "delivered",
      // Slack permalinks need a `chat.getPermalink` call; the channel+ts pair
      // is what a human and a log both actually use.
      url: null,
      channel: result.channel,
      ts: result.ts,
      messageCount: result.messageCount,
    };
  },
});
