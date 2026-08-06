/**
 * Writes a markdown brief into a real Google Doc.
 *
 * WHY NOT `tasks/pattern-hunter-publish-gdoc.ts`. That task is the right shape
 * for its own job -- a browser-triggered "save THIS report to MY Drive", where
 * Pattern Hunter owns the consent dance and every call creates a new doc. The
 * morning brief is a scheduled job for one known owner that wants an UPDATE:
 * a stable doc id and URL that today's brief overwrites, so a bookmark keeps
 * working. Pattern Hunter's `POST /publish/gdoc` has no update path, and
 * routing a cron through a consent-required 409 would mean a brief that
 * silently stops publishing the day consent lapses.
 *
 * So this goes direct, through `lib/google-auth.ts` -- the same fresh-token
 * path `tasks/fetch-emails.ts` uses, and the one the rework brief calls for.
 *
 * MARKDOWN CONVERSION IS DRIVE'S, NOT OURS. Drive imports `text/markdown` into
 * a native Google Doc (headings, bold, lists and links all survive), so
 * `lib/format-brief.ts`'s existing output goes up untouched. No second
 * markdown renderer to keep in step with the Slack one.
 *
 * SCOPES. The stored token must carry Drive write scope
 * (`https://www.googleapis.com/auth/drive.file` is enough for docs this client
 * created; updating a doc created by a DIFFERENT OAuth client needs the
 * broader `.../auth/drive`). cboti's `ALL_SCOPES` includes both, but a token
 * granted for Gmail alone will 403 here -- deliberately loud rather than
 * degraded, since a brief that silently stops reaching Drive is worse than one
 * that reports why.
 */

import { google } from "googleapis";
import { getFreshGmailAuth } from "./google-auth.js";

export type UpsertMarkdownDocResult = {
  documentId: string;
  documentUrl: string;
  /** false when an existing doc was overwritten in place. */
  created: boolean;
};

export type UpsertMarkdownDocOptions = {
  ownerEmail: string;
  title: string;
  markdown: string;
  /** When set, this doc's contents are REPLACED and its id/URL stay stable. */
  documentId?: string;
  /** Parent folder for a newly created doc. Ignored when `documentId` is set. */
  folderId?: string;
};

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const MARKDOWN_MIME = "text/markdown";

function docUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

export async function upsertMarkdownDoc(
  options: UpsertMarkdownDocOptions
): Promise<UpsertMarkdownDocResult> {
  const auth = await getFreshGmailAuth(options.ownerEmail);
  const drive = google.drive({ version: "v3", auth });
  const media = { mimeType: MARKDOWN_MIME, body: options.markdown };

  if (options.documentId) {
    const updated = await drive.files.update({
      fileId: options.documentId,
      media,
      // Only the name. Sending `mimeType` on an update is rejected as a
      // mimeType CHANGE -- the file stays a Google Doc and Drive converts the
      // uploaded markdown into it.
      requestBody: { name: options.title },
      supportsAllDrives: true,
      fields: "id,webViewLink",
    });
    const id = updated.data.id ?? options.documentId;
    return { documentId: id, documentUrl: updated.data.webViewLink ?? docUrl(id), created: false };
  }

  const created = await drive.files.create({
    media,
    requestBody: {
      name: options.title,
      // Requesting the Google Doc mimeType on create is what triggers the
      // markdown -> Doc conversion; without it the markdown lands as a plain
      // text file.
      mimeType: GOOGLE_DOC_MIME,
      ...(options.folderId ? { parents: [options.folderId] } : {}),
    },
    supportsAllDrives: true,
    fields: "id,webViewLink",
  });

  const id = created.data.id;
  if (!id) {
    throw new Error("Drive files.create returned no file id for the morning brief doc");
  }
  return { documentId: id, documentUrl: created.data.webViewLink ?? docUrl(id), created: true };
}
