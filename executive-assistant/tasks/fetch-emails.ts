import { task, logger } from "@trigger.dev/sdk";
import { google, gmail_v1 } from "googleapis";
import { getFreshGmailAuth } from "../lib/google-auth.js";

export type EmailBatch = {
  emails: Array<{
    id: string;
    thread_id: string;
    sender: string | null;
    subject: string;
    snippet: string;
    body: string;
    date: string | null;
    labels: string[];
  }>;
  count: number;
  fetched_at: string;
  query_used: string;
};

export type FetchEmailsPayload = {
  /**
   * Canonical, lowercased primary email -- NOT a Slack user ID. It is
   * forwarded straight to auth-service as `owner_email`, which rejects
   * platform-prefixed identifiers (see lib/google-auth.ts and
   * infra-bonker#409). Named `userId` until 2026-08-02, which is exactly how
   * a Slack ID ended up here and 400'd the whole morning-brief chain.
   */
  ownerEmail: string;
  maxResults?: number;
};

/** Ported from cboti's GmailMessage._decode_body: depth-first text/plain, no text/html fallback. */
function decodeBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain") {
    const data = payload.body?.data;
    if (data) return Buffer.from(data, "base64url").toString("utf-8");
  }
  if (payload.mimeType?.startsWith("multipart/")) {
    for (const part of payload.parts ?? []) {
      const text = decodeBody(part);
      if (text) return text;
    }
  }
  return "";
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | null {
  const match = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
}

function parseDate(dateHeader: string | null): string | null {
  if (!dateHeader) return null;
  const parsed = new Date(dateHeader);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export const fetchEmails = task({
  id: "fetch-emails",
  // The default small-1x (0.5 GB) is not enough to import `googleapis`, which
  // pulls in the whole discovery surface. Observed intermittently: attempt 1
  // dies with "Process exited with code -1 after signal SIGKILL" before any
  // user code runs, attempt 2 sometimes squeaks through -- which made the
  // morning-brief chain fail at its first step with a crash that names no
  // cause. 1 GB clears it.
  machine: "small-2x",
  retry: { maxAttempts: 2 },
  run: async (payload: FetchEmailsPayload): Promise<EmailBatch> => {
    logger.info("starting fetch-emails");
    const maxResults = payload.maxResults ?? 25;
    const query = "is:unread";

    const auth = await getFreshGmailAuth(payload.ownerEmail);
    const gmail = google.gmail({ version: "v1", auth });

    const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
    const messageRefs = list.data.messages ?? [];

    const emails = await Promise.all(
      messageRefs.map(async (ref) => {
        const full = await gmail.users.messages.get({ userId: "me", id: ref.id!, format: "full" });
        const headers = full.data.payload?.headers;
        return {
          id: full.data.id!,
          thread_id: full.data.threadId ?? "",
          sender: header(headers, "from"),
          subject: header(headers, "subject") ?? "(no subject)",
          snippet: full.data.snippet ?? "",
          body: decodeBody(full.data.payload),
          date: parseDate(header(headers, "date")),
          labels: full.data.labelIds ?? [],
        };
      })
    );

    return {
      emails,
      count: emails.length,
      fetched_at: new Date().toISOString(),
      query_used: query,
    };
  
    logger.info("completed fetch-emails");
  },
});
