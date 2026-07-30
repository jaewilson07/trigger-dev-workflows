import { task } from "@trigger.dev/sdk";

export type PostSlackPayload = {
  channel: string;
  text: string;
};

export type PostSlackResult = {
  channel: string;
  ts: string;
};

export const postSlack = task({
  id: "post-slack",
  retry: { maxAttempts: 3 },
  run: async (payload: PostSlackPayload): Promise<PostSlackResult> => {
    const token = process.env.DATACREW_SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error("DATACREW_SLACK_BOT_TOKEN is not set");
    }

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: payload.channel,
        text: payload.text,
      }),
    });

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      channel?: string;
      ts?: string;
    };

    if (!data.ok) {
      throw new Error(`Slack chat.postMessage failed: ${data.error ?? "unknown error"}`);
    }

    return { channel: data.channel!, ts: data.ts! };
  },
});
