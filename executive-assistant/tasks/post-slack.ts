import { task, logger } from "@trigger.dev/sdk";
import { chunkBlocks, type SlackBlock } from "../lib/slack-blocks.js";

export type PostSlackPayload = {
  channel: string;
  /**
   * Fallback text. Slack uses this for notifications, search and screen
   * readers, so it is required even when `blocks` is supplied -- omitting it
   * produces a push notification that just says "message from <bot>".
   */
  text: string;
  blocks?: SlackBlock[];
};

export type PostSlackResult = {
  channel: string;
  /** ts of the FIRST message posted, so a reader lands at the top of the brief. */
  ts: string;
  messageCount: number;
};

export const postSlack = task({
  id: "post-slack",
  retry: { maxAttempts: 3 },
  run: async (payload: PostSlackPayload): Promise<PostSlackResult> => {
    logger.info("starting post-slack");
    const token = process.env.DATACREW_SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error("DATACREW_SLACK_BOT_TOKEN is not set");
    }

    // Chunk on BLOCK boundaries. Left to itself Slack silently splits a
    // >4000-char `text` at an arbitrary character offset, which cut entries in
    // half mid-sentence (observed 2026-08-02). Posting sequentially, not in
    // parallel, so the parts arrive in order.
    const messages = payload.blocks ? chunkBlocks(payload.blocks) : [null];
    let firstTs: string | null = null;
    let channel = payload.channel;

    for (const [i, blocks] of messages.entries()) {
      const body: Record<string, unknown> = {
        channel: payload.channel,
        text: i === 0 ? payload.text : `${payload.text} (continued ${i + 1}/${messages.length})`,
      };
      if (blocks) body.blocks = blocks;

      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });

      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        errors?: string[];
        channel?: string;
        ts?: string;
      };

      if (!data.ok) {
        // `errors` carries the per-block detail for invalid_blocks; without it
        // the bare error code says nothing about which block was rejected.
        const detail = data.errors?.length ? ` (${data.errors.join("; ")})` : "";
        throw new Error(
          `Slack chat.postMessage failed on part ${i + 1}/${messages.length}: ${data.error ?? "unknown error"}${detail}`
        );
      }
      if (firstTs === null) firstTs = data.ts!;
      if (data.channel) channel = data.channel;
    }

    return { channel, ts: firstTs!, messageCount: messages.length };
  
    logger.info("completed post-slack");
  },
});
