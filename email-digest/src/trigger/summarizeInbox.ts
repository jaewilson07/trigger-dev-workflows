import { task, logger, tags } from "@trigger.dev/sdk";
import { google } from "googleapis";

type SummarizeInboxPayload = {
  /** e.g. "slack:U0123ABC" — matches the auth-service google_tokens _id convention */
  userId: string;
  slackChannelId: string;
  /** Slack response_url from the slash command payload */
  responseUrl: string;
  maxMessages?: number;
};

type StoredToken = {
  platform: string;
  user_id: string;
  token_json: string;
  scope: string;
  updated_at: string;
};

type EmailSummaryInput = {
  from: string;
  subject: string;
  snippet: string;
};

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL ?? "http://auth-service:8000";
const LETTA_SERVER_URL = process.env.LETTA_SERVER_URL ?? "http://letta-server:8283";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function getGoogleToken(userId: string): Promise<StoredToken | null> {
  const res = await fetch(`${AUTH_SERVICE_URL}/auth/google/token/${encodeURIComponent(userId)}`, {
    headers: { "X-Token-API-Key": requireEnv("GOOGLE_TOKEN_API_KEY") },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`auth-service token lookup failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as StoredToken;
}

function buildOAuthClient(tokenJson: string) {
  const credentials = JSON.parse(tokenJson);
  const client = new google.auth.OAuth2();
  // googleapis refreshes the access token automatically on expiry as long as
  // a refresh_token is present — no manual refresh needed for v1. The
  // refreshed token is NOT written back to auth-service's google_tokens store
  // yet (fast-follow: PUT /auth/google/token/{userId} on the `tokens` event).
  client.setCredentials(credentials);
  return client;
}

async function fetchRecentEmails(
  auth: InstanceType<typeof google.auth.OAuth2>,
  maxMessages: number
): Promise<EmailSummaryInput[]> {
  const gmail = google.gmail({ version: "v1", auth });
  const list = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults: maxMessages,
  });
  const messages = list.data.messages ?? [];

  return Promise.all(
    messages.map(async (m) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      });
      const headers = msg.data.payload?.headers ?? [];
      const from = headers.find((h) => h.name === "From")?.value ?? "unknown sender";
      const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
      return { from, subject, snippet: msg.data.snippet ?? "" };
    })
  );
}

async function summarizeWithLetta(emails: EmailSummaryInput[]): Promise<string> {
  const agentId = requireEnv("LETTA_EMAIL_DIGEST_AGENT_ID");
  const body = emails
    .map((e, i) => `${i + 1}. From: ${e.from} | Subject: ${e.subject} | Snippet: ${e.snippet}`)
    .join("\n");

  const res = await fetch(`${LETTA_SERVER_URL}/v1/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: `Here are ${emails.length} emails:\n${body}` }],
    }),
  });
  if (!res.ok) {
    throw new Error(`letta-server summarize failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { messages: { message_type: string; content?: string }[] };
  const assistantMessage = data.messages.find((m) => m.message_type === "assistant_message");
  return assistantMessage?.content ?? "(no summary produced)";
}

async function postToSlack(responseUrl: string, text: string): Promise<void> {
  const res = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  });
  if (!res.ok) {
    throw new Error(`slack response_url post failed: ${res.status} ${await res.text()}`);
  }
}

export const summarizeInbox = task({
  id: "summarize-inbox",
  run: async (payload: SummarizeInboxPayload) => {
    tags.add(["slack", payload.userId]);
    const maxMessages = payload.maxMessages ?? 20;

    logger.info("Fetching Gmail token", { userId: payload.userId });
    const token = await getGoogleToken(payload.userId);
    if (!token) {
      logger.warn("No Gmail token on file for user", { userId: payload.userId });
      await postToSlack(
        payload.responseUrl,
        `You haven't connected Gmail yet — visit https://api.datacrew.space/auth/google?user_id=${encodeURIComponent(
          payload.userId
        )} to connect it, then run /email-summary again.`
      );
      return { status: "not_connected" as const };
    }

    const auth = buildOAuthClient(token.token_json);

    logger.info("Fetching recent inbox messages", { maxMessages });
    const emails = await logger.trace("gmail.fetch", async () => fetchRecentEmails(auth, maxMessages));
    logger.info(`Fetched ${emails.length} emails`);

    if (emails.length === 0) {
      await postToSlack(payload.responseUrl, "Your inbox is empty — nothing to summarize.");
      return { status: "empty" as const };
    }

    logger.info("Summarizing via local Letta email-digest agent");
    const summary = await logger.trace("letta.summarize", async () => summarizeWithLetta(emails));

    logger.info("Posting summary back to Slack");
    await postToSlack(payload.responseUrl, summary);

    return { status: "ok" as const, emailCount: emails.length };
  },
});
