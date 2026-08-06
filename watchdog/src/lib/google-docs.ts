/**
 * Writes a markdown report into a real Google Doc.
 *
 * A VERBATIM COPY of `executive-assistant/lib/google-docs.ts` — see the
 * composition audit's R5: each project has its own `package.json` and
 * `trigger.config.ts` and deploys independently, so sharing this across them
 * needs a real shared package, which this rework does not attempt. Copying the
 * one Drive implementation that has been verified against live credentials
 * beats writing a fourth from scratch.
 *
 * MARKDOWN CONVERSION IS DRIVE'S, NOT OURS. Drive imports `text/markdown` into
 * a native Google Doc (headings, bold, lists, tables and links all survive),
 * so `lib/infra-health.ts`'s `buildMarkdown` output goes up untouched. No
 * second renderer to keep in step with the Slack one.
 *
 * SCOPES. The stored token must carry Drive write scope
 * (`https://www.googleapis.com/auth/drive.file` is enough for docs this client
 * created; updating a doc created by a DIFFERENT OAuth client needs the
 * broader `.../auth/drive`). cboti's `ALL_SCOPES` includes both, but a token
 * granted for Gmail alone will 403 here -- deliberately loud rather than
 * degraded, since a report that silently stops reaching Drive is worse than
 * one that reports why.
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
    throw new Error("Drive files.create returned no file id for the infra health doc");
  }
  return { documentId: id, documentUrl: created.data.webViewLink ?? docUrl(id), created: true };
}
