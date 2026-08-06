import { task } from "@trigger.dev/sdk";
import { postSlack } from "./post-slack.js";
import { buildBriefBlocks } from "../lib/slack-blocks.js";
import { skipped, type BriefDeliveryBase, type DeliveryOutcome } from "../lib/brief-delivery.js";

/**
 * Slack delivery for the brief. Behaviourally identical to the block that used
 * to live inline in `morning-brief.ts` -- same blocks, same markdown fallback,
 * same `post-slack` call.
 *
 * A THIN ADAPTER OVER `post-slack`, not a replacement for it. `post-slack`
 * stays the generic Slack primitive (channel/text/blocks, chunking, error
 * detail); this file holds the one brief-specific decision -- that the brief
 * renders as Block Kit with the markdown as fallback -- so the primitive stays
 * reusable by anything else that wants to post.
 */
export type DeliverSlackPayload = BriefDeliveryBase & {
  /** Defaults to MORNING_BRIEF_SLACK_CHANNEL. */
  channel?: string;
};

export const deliverSlack = task({
  id: "deliver-slack",
  // No retry here: `post-slack` already retries the actual HTTP call 3x, and a
  // retry at this level would repost a brief that had partially succeeded.
  run: async (payload: DeliverSlackPayload): Promise<DeliveryOutcome> => {
    if (payload.enabled === false) {
      return skipped("slack", "disabled by caller");
    }

    const channel = payload.channel ?? process.env.MORNING_BRIEF_SLACK_CHANNEL ?? "";
    if (!channel) {
      return skipped("slack", "MORNING_BRIEF_SLACK_CHANNEL not set and no channel in payload");
    }

    const result = await postSlack
      .triggerAndWait({
        channel,
        // Markdown stays as the notification/accessibility fallback; the
        // rendered brief comes from blocks, since Slack does not speak
        // GitHub-flavored markdown (see lib/slack-blocks.ts).
        text: payload.briefMarkdown,
        blocks: buildBriefBlocks(
          payload.research.triageResults,
          payload.research.topicResults,
          // The researched date, not today's -- a run that crosses midnight or
          // a re-delivery would otherwise title yesterday's brief with today.
          payload.research.date
        ),
      })
      .unwrap();

    return {
      destination: "slack",
      status: "delivered",
      // Slack permalinks need a `chat.getPermalink` call; the channel+ts pair
      // below is what `log-activity` and a human both actually use.
      url: null,
      channel: result.channel,
      ts: result.ts,
      messageCount: result.messageCount,
    };
  },
});
