import { task, logger } from "@trigger.dev/sdk";
import { outputDelivered, outputFailed, outputSkipped } from "../lib/storm-types.js";
import type { StormBriefingWithMarkdown, OutputResult } from "../lib/storm-types.js";

export type OutputGoogleDocPayload = {
  briefing: StormBriefingWithMarkdown;
  /** Slack user ID — the key the auth service stores Google OAuth tokens under. */
  slackUserId: string;
};

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL ?? "http://auth-service:8000";

/** Auth-service response for GET /auth/google/token/{slackUserId}. */
type GoogleTokenRecord = {
  /** The key the token is stored under (canonical owner email). */
  owner_email?: string;
  /** The Google account the token belongs to — the address to share the doc with. */
  account_email?: string;
  /** JSON *string* holding the OAuth token object — must be parsed. */
  token_json?: string;
  scope?: string;
  updated_at?: string;
};

/**
 * output-google-doc — writes the research report to a Google Doc and shares it
 * with the requesting user.
 *
 * Flow: auth-service token fetch → Drive file create → Docs `batchUpdate` →
 * Drive permission share. Never throws: every failure is reported as
 * `success: false` so it can't sink the other output destinations.
 *
 * The parent workflow only requests this destination when the user has a Google
 * token on file (see `datacrew/slackbot/commands/research.py`). Note
 * infra-bonker#396 — the auth service keys by canonical owner_email, so a raw
 * Slack user ID may 400 until that lands.
 */
export const outputGoogleDoc = task({
  id: "output-google-doc",
  retry: { maxAttempts: 1 },
  run: async (payload: OutputGoogleDocPayload): Promise<OutputResult> => {
    logger.info("starting output-google-doc");
    const { briefing, slackUserId } = payload;

    const apiKey = process.env.GOOGLE_TOKEN_API_KEY ?? "";
    if (!apiKey) {
      const error = "GOOGLE_TOKEN_API_KEY not set";
      logger.warn("output-google-doc: skipping", { error, slackUserId });
      return outputSkipped("google_doc", error);
    }

    try {
      // 1. Fetch the user's Google OAuth token from the auth service.
      const tokenRes = await fetch(
        `${AUTH_SERVICE_URL}/auth/google/token/${encodeURIComponent(slackUserId)}`,
        {
          headers: { "X-Token-API-Key": apiKey },
          signal: AbortSignal.timeout(15_000),
        }
      );

      if (!tokenRes.ok) {
        throw new Error(`auth service error: ${tokenRes.status} ${await tokenRes.text()}`);
      }

      const tokenRecord = (await tokenRes.json()) as GoogleTokenRecord;
      if (!tokenRecord.token_json) {
        throw new Error("auth service returned no token_json");
      }

      // token_json is a JSON string, not an object.
      const tokenObj = JSON.parse(tokenRecord.token_json) as { access_token?: string };
      const accessToken = tokenObj.access_token;
      if (!accessToken) {
        throw new Error("no access_token in stored Google token");
      }

      const accountEmail = tokenRecord.account_email;
      const authHeaders = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      };

      // 2. Create the (empty) Google Doc via the Drive API.
      const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: `STORM Research: ${briefing.topic}`,
          mimeType: "application/vnd.google-apps.document",
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!createRes.ok) {
        throw new Error(`Drive create error: ${createRes.status} ${await createRes.text()}`);
      }

      const doc = (await createRes.json()) as { id?: string; webViewLink?: string };
      const docId = doc.id;
      if (!docId) {
        throw new Error("Drive create returned no file id");
      }
      const docUrl = doc.webViewLink ?? `https://docs.google.com/document/d/${docId}/edit`;

      // 3. Write the report body. The Docs API inserts plain text, so Markdown
      // syntax (#, *, [1]) shows up literally in the doc.
      // TODO: translate headings/lists/bold into updateParagraphStyle +
      // updateTextStyle requests so the doc reads as formatted prose.
      const writeRes = await fetch(
        `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
        {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            requests: [{ insertText: { location: { index: 1 }, text: briefing.markdown } }],
          }),
          signal: AbortSignal.timeout(30_000),
        }
      );

      // The doc already exists at this point — a failed write shouldn't discard
      // the URL, so log it and carry on to sharing.
      if (!writeRes.ok) {
        logger.warn("output-google-doc: content write failed, doc was created empty", {
          docId,
          status: writeRes.status,
          error: await writeRes.text(),
        });
      }

      // 4. Share the doc with the user's Google account.
      if (accountEmail) {
        const shareRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${docId}/permissions`,
          {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              type: "user",
              role: "writer",
              emailAddress: accountEmail,
            }),
            signal: AbortSignal.timeout(15_000),
          }
        );

        // Not fatal: the doc exists and is owned by the token holder, who can
        // still open it — it just isn't shared onward.
        if (!shareRes.ok) {
          logger.warn("output-google-doc: share failed", {
            docId,
            status: shareRes.status,
            error: await shareRes.text(),
          });
        }
      } else {
        logger.warn("output-google-doc: no account_email on token record, doc not shared", {
          docId,
          slackUserId,
        });
      }

      logger.info("output-google-doc: created doc", {
        docId,
        docUrl,
        accountEmail,
        topic: briefing.topic,
        markdownChars: briefing.markdown.length,
      });

      return outputDelivered("google_doc", docUrl);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn("output-google-doc: failed", { error, slackUserId, topic: briefing.topic });
      return outputFailed("google_doc", error);
    }
  },
});
