/**
 * Update/delete/flag an existing mdrag document by `document_uid`.
 *
 * mdrag's MCP surface only *creates* documents (`save_text_to_knowledge`,
 * `save_url_to_knowledge`) — there is no MCP tool that edits one in place.
 * The REST endpoints exist (`PUT`/`DELETE`/`POST .../flag` on
 * `/api/v1/documents/{document_uid}`); this module is the typed path to
 * them, built on {@link mdragCall}/{@link mdragCredentialFromEnv} so the
 * auth-mode-vs-hostname mistake (`--location-trusted`, in the old curl
 * procedure) is structurally impossible rather than documented in prose —
 * `mdragCall` already refuses a vouching call aimed at a stripping host, and
 * a token call is unaffected by the `mdrag.datacrew.space` -> host redirect
 * either way.
 *
 * See `.agents/skills/mdrag-update-document/SKILL.md` for the operator-facing
 * guidance (when to update vs. delete vs. flag, troubleshooting) — this file
 * is the mechanism it now points at instead of restating the curl dance.
 */

import { mdragCall, mdragCredentialFromEnv, type MdragCredential } from "./mdrag-hop.js";

export type DocumentUpdateBody = {
  content: string;
  title?: string;
  editor_note?: string;
};

export type DocumentUpdateResponse = {
  document_uid: string;
  version: number;
  updated_at: string;
  message: string;
  gdocs_synced?: boolean;
};

export type MdragDocumentRequest = {
  url: string;
  method: "PUT" | "DELETE" | "POST";
  headers: Record<string, string>;
  body?: string;
};

export type MdragDocumentOptions = {
  /** The end user to act for, when vouching. Passed through to {@link mdragCredentialFromEnv}. */
  userEmail?: string;
  /** Explicit credential, bypassing env resolution — mainly for tests. */
  credential?: MdragCredential;
  /** Destination override; defaults to {@link mdragBaseUrl}. */
  baseUrl?: string;
};

function credentialFor(options?: MdragDocumentOptions): MdragCredential {
  return options?.credential ?? mdragCredentialFromEnv(options?.userEmail);
}

/** Build the `PUT /api/v1/documents/{document_uid}` request. Pure — no network. */
export function buildUpdateDocumentRequest(
  documentUid: string,
  body: DocumentUpdateBody,
  credential: MdragCredential,
  baseUrl?: string
): MdragDocumentRequest {
  const call = mdragCall(`/api/v1/documents/${encodeURIComponent(documentUid)}`, credential, baseUrl);
  return { url: call.url, method: "PUT", headers: call.headers, body: JSON.stringify(body) };
}

/** Build the `DELETE /api/v1/documents/{document_uid}` request. Pure — no network. */
export function buildDeleteDocumentRequest(
  documentUid: string,
  credential: MdragCredential,
  baseUrl?: string
): MdragDocumentRequest {
  const call = mdragCall(`/api/v1/documents/${encodeURIComponent(documentUid)}`, credential, baseUrl);
  return { url: call.url, method: "DELETE", headers: call.headers };
}

/** Build the `POST /api/v1/documents/{document_uid}/flag` request. Pure — no network. */
export function buildFlagDocumentRequest(
  documentUid: string,
  credential: MdragCredential,
  baseUrl?: string
): MdragDocumentRequest {
  const call = mdragCall(`/api/v1/documents/${encodeURIComponent(documentUid)}/flag`, credential, baseUrl);
  return { url: call.url, method: "POST", headers: call.headers };
}

async function send(req: MdragDocumentRequest): Promise<Response> {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MdragDocumentError(`${req.method} ${req.url} -> ${res.status}: ${text}`);
  }
  return res;
}

export class MdragDocumentError extends Error {}

/**
 * Update an existing document's content/title/editor_note in place.
 *
 * Archives the prior version per ADR-0038 (archive-not-destroy) — a genuine
 * content change is not lost, it is superseded. A no-op update (identical
 * content) does not create a new version.
 */
export async function updateMdragDocument(
  documentUid: string,
  body: DocumentUpdateBody,
  options?: MdragDocumentOptions
): Promise<DocumentUpdateResponse> {
  const req = buildUpdateDocumentRequest(documentUid, body, credentialFor(options), options?.baseUrl);
  return (await send(req)).json() as Promise<DocumentUpdateResponse>;
}

/**
 * Hard-delete a document. Not reversible — read `mdrag-kb-writes-are-irreversible`
 * before calling this; prefer {@link flagMdragDocument} or
 * {@link updateMdragDocument} unless the document genuinely should not exist.
 */
export async function deleteMdragDocument(documentUid: string, options?: MdragDocumentOptions): Promise<void> {
  const req = buildDeleteDocumentRequest(documentUid, credentialFor(options), options?.baseUrl);
  await send(req);
}

/** Mark a document potentially outdated without touching its content. */
export async function flagMdragDocument(documentUid: string, options?: MdragDocumentOptions): Promise<void> {
  const req = buildFlagDocumentRequest(documentUid, credentialFor(options), options?.baseUrl);
  await send(req);
}
