import { task, logger } from "@trigger.dev/sdk";
import type { StormBriefingWithMarkdown, OutputResult } from "../lib/storm-types.js";

export type OutputSlackMdPayload = {
  briefing: StormBriefingWithMarkdown;
  /** Slack channel ID, or "user:U123..." to DM that user. */
  slackChannel: string;
};

/** Slack refuses messages over ~40k chars; leave room for the fences. */
const MAX_SNIPPET_CHARS = 38_000;

/**
 * output-slack-md — uploads the full Markdown report to Slack as a .md file.
 *
 * Slack's `files.upload` is retired and `files.uploadV2` is an SDK helper, not
 * an HTTP endpoint — the real wire protocol is three calls:
 *   1. files.getUploadURLExternal  → { upload_url, file_id }
 *   2. POST the bytes to upload_url (multipart/form-data)
 *   3. files.completeUploadExternal → shares the file into the channel
 *
 * If any of that fails, we fall back to posting the Markdown in a code block
 * so the user still gets the report.
 */
export const outputSlackMd = task({
  id: "output-slack-md",
  retry: { maxAttempts: 1 },
  run: async (payload: OutputSlackMdPayload): Promise<OutputResult> => {
    logger.info("starting output-slack-md");
    const { briefing, slackChannel } = payload;

    const token = process.env.DATACREW_SLACK_BOT_TOKEN ?? "";
    if (!token) {
      const error = "DATACREW_SLACK_BOT_TOKEN not set";
      logger.warn("output-slack-md: skipping upload", { error });
      return { destination: "slack_md", success: false, error };
    }

    const filename = `storm-research-${slugify(briefing.topic)}.md`;
    const title = `STORM Research: ${briefing.topic}`;

    try {
      const channelId = await resolveChannelId(token, slackChannel);
      const url = await uploadMarkdown(token, channelId, filename, title, briefing.markdown);
      logger.info("output-slack-md: uploaded markdown", { channel: channelId, filename });
      return { destination: "slack_md", success: true, url };
    } catch (err) {
      const uploadError = err instanceof Error ? err.message : String(err);
      logger.warn("output-slack-md: file upload failed, falling back to a code block", {
        error: uploadError,
      });

      // Fallback: post the markdown inline so the report still lands somewhere.
      try {
        const channelId = await resolveChannelId(token, slackChannel);
        const truncated =
          briefing.markdown.length > MAX_SNIPPET_CHARS
            ? `${briefing.markdown.slice(0, MAX_SNIPPET_CHARS)}\n\n…(truncated)`
            : briefing.markdown;
        await slackJson(token, "chat.postMessage", {
          channel: channelId,
          text: `*${title}*\n\`\`\`\n${truncated}\n\`\`\``,
        });
        logger.info("output-slack-md: posted markdown as a code block");
        return { destination: "slack_md", success: true };
      } catch (fallbackErr) {
        const error = `upload failed (${uploadError}); fallback failed (${
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        })`;
        logger.warn("output-slack-md: fallback failed", { error });
        return { destination: "slack_md", success: false, error };
      }
    }
  },
});

async function uploadMarkdown(
  token: string,
  channelId: string,
  filename: string,
  title: string,
  markdown: string
): Promise<string | undefined> {
  const bytes = new TextEncoder().encode(markdown);

  // 1. Reserve an upload URL.
  const reserved = (await slackForm(token, "files.getUploadURLExternal", {
    filename,
    length: String(bytes.byteLength),
  })) as { upload_url: string; file_id: string };

  // 2. PUSH the bytes to the (non-api.slack.com) upload URL.
  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: "text/markdown" }), filename);

  const uploadRes = await fetch(reserved.upload_url, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(60_000),
  });
  if (!uploadRes.ok) {
    throw new Error(`Slack upload URL error: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  // 3. Complete the upload and share it into the channel.
  const completed = (await slackJson(token, "files.completeUploadExternal", {
    files: [{ id: reserved.file_id, title }],
    channel_id: channelId,
  })) as { files?: { permalink?: string }[] };

  return completed.files?.[0]?.permalink;
}

/**
 * Callers address DMs as "user:U123..." (the DataCrew convention). File uploads
 * need a real conversation ID, so open the DM to get one.
 */
async function resolveChannelId(token: string, channel: string): Promise<string> {
  const raw = channel.startsWith("user:") ? channel.slice("user:".length) : channel;
  if (!raw.startsWith("U") && !raw.startsWith("W")) {
    return raw; // already a channel/conversation ID
  }

  const opened = (await slackJson(token, "conversations.open", { users: raw })) as {
    channel?: { id?: string };
  };
  const id = opened.channel?.id;
  if (!id) {
    throw new Error(`conversations.open returned no channel for ${raw}`);
  }
  return id;
}

async function slackJson(token: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return readSlackResponse(res, method);
}

async function slackForm(
  token: string,
  method: string,
  params: Record<string, string>
): Promise<unknown> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${token}`,
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  return readSlackResponse(res, method);
}

async function readSlackResponse(res: Response, method: string): Promise<unknown> {
  if (!res.ok) {
    throw new Error(`Slack ${method} error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack ${method} returned error: ${data.error ?? "unknown"}`);
  }
  return data;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report"
  );
}
