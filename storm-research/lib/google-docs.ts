/**
 * Writes a markdown report into a real Google Doc.
 *
 * A VERBATIM COPY of `executive-assistant/lib/google-docs.ts`, and deliberately
 * a copy rather than an import: the two projects have separate `package.json`
 * and `trigger.config.ts` files and are deployed independently, so sharing code
 * across them needs a real shared package — work the composition audit scoped
 * out (R5) and this rework does not attempt. What it DOES do is retire this
 * project's third, worse Google Doc implementation in favour of the one that
 * has actually been verified against live credentials.
 *
 * WHAT THE OLD `output-google-doc.ts` GOT WRONG. It drove the Drive + Docs REST
 * APIs by hand and inserted the report with `documents.batchUpdate`'s
 * `insertText`, which takes PLAIN TEXT — so every `#`, `**bold**` and `[1]`
 * landed literally in the doc, a bug its own TODO acknowledged. Drive's
 * `text/markdown` import (below) converts headings, bold, lists and links into
 * real Doc formatting, which is the same reason the morning brief uses it.
 *
 * MARKDOWN CONVERSION IS DRIVE'S, NOT OURS. Requesting the Google Doc mimeType
 * on create is what triggers the conversion; without it the markdown lands as a
 * plain text file. No second markdown renderer to keep in step.
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
    throw new Error("Drive files.create returned no file id for the STORM report doc");
  }
  return { documentId: id, documentUrl: created.data.webViewLink ?? docUrl(id), created: true };
}
