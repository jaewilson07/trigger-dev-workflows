/**
 * Thin HTTP client for mdrag's learn vault (`/api/v1/learn/*`).
 *
 * The vault is the learn workflow's WORKSPACE — the served, printable surface a
 * learner actually reads. It is deliberately not the workflow's Store.
 *
 * This module's header used to claim it was ("the DURABLE STATE… the Store, in
 * LangChain's vocabulary"). ADR-0045 settled otherwise: per ADR-0005 the Mongo
 * `documents` collection is the system of record, so what the vault holds are
 * RENDERINGS of records that live in the Conversation's Collection. Losing the
 * vault loses formatting; losing the Collection loses the learner's history.
 *
 * The split the `create-workflow` skill (step 2) insists on is still the thing
 * to get right — nothing a later run needs may live in the orchestrator — but
 * the Store side of it is `lib/learn-annotations.ts`, not this file. Reach for
 * this one to write something a human reads; reach for that one to write
 * something a later stage reads back.
 *
 * ## Auth
 *
 * Same credential and same header as `lib/mdrag-primitives.ts`:
 * `DATACREW_API_TOKEN` (a `dc_` JWT, already in `trigger.config.ts`'s
 * `SYNCED_SECRETS`) sent as `X-DC-Token`, not `Authorization: Bearer` —
 * `MDRAG_URL` defaults to `wiki.datacrew.space`, which sits behind Cloudflare
 * Access, and CF Access strips `Authorization` on routes it fronts.
 *
 * ## The writers need mdrag#1543
 *
 * Until that PR is deployed the vault's REST surface is READ-ONLY: writes
 * existed only as `learn` MCP tools, which this project deliberately does not
 * speak (see `mdrag-primitives.ts`'s header — "no MCP session involved"). Every
 * writer below 404s against an older mdrag. That is why they throw loudly
 * rather than returning a status object: a 404 here means the deploy is behind,
 * and a workflow that treats it as a soft failure would silently produce
 * nothing for hours.
 */

import { resolveDatacrewToken } from "./datacrew-token.js";

const MDRAG_URL = (process.env.MDRAG_URL ?? "https://wiki.datacrew.space").replace(/\/+$/, "");

/**
 * Plain document reads/writes, not LLM-backed — so the 120s used elsewhere for
 * mdrag's document/ingest endpoints, not the 180s `mdrag-primitives.ts` uses
 * for its LLM-backed primitives.
 */
const LEARN_TIMEOUT_MS = 120_000;

export class LearnVaultError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly status: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = "LearnVaultError";
  }
}

/** mdrag's `LearnWorkspaceIndex`. */
export type LearnWorkspaceIndex = {
  slug: string;
  user_email: string;
  lessons: string[];
  references: string[];
  learning_records: string[];
  podcasts: string[];
  has_mission: boolean;
};

async function request<TResponse>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown
): Promise<TResponse> {
  const token = resolveDatacrewToken();
  if (!token) {
    // Loud here rather than as an opaque 401 several frames down — the same
    // posture `brief-research.ts` takes on a missing ownerEmail.
    throw new Error(
      "learn-vault needs DATACREW_API_TOKEN; it is in trigger.config.ts's " +
        "SYNCED_SECRETS, so an empty value means the Infisical sync failed"
    );
  }

  const url = `${MDRAG_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-DC-Token": token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(LEARN_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new LearnVaultError(
      `learn vault ${method} ${path} failed: ${res.status}`,
      path,
      res.status,
      text.slice(0, 500)
    );
  }
  if (!text) return undefined as TResponse;
  try {
    return JSON.parse(text) as TResponse;
  } catch {
    throw new LearnVaultError(
      `learn vault ${method} ${path} returned non-JSON`,
      path,
      res.status,
      text.slice(0, 500)
    );
  }
}

/** Derive the vault's own slug for a topic, so callers don't reimplement slugify. */
export async function inferSlug(text: string): Promise<string> {
  const res = await request<{ slug: string }>("POST", "/api/v1/learn/slug", { text });
  return res.slug;
}

/**
 * Read the workspace index. Returns `null` for a workspace that does not exist
 * yet — a first run for a topic is the normal case, not an error.
 */
export async function getWorkspaceIndex(slug: string): Promise<LearnWorkspaceIndex | null> {
  try {
    return await request<LearnWorkspaceIndex>("GET", `/api/v1/learn/${slug}/`);
  } catch (err) {
    if (err instanceof LearnVaultError && err.status === 404) return null;
    throw err;
  }
}

export async function writeMission(slug: string, markdown: string): Promise<void> {
  await request("POST", `/api/v1/learn/${slug}/mission`, { markdown });
}

/** Create a lesson. The vault assigns the `0001-`, `0002-` … prefix. */
export async function createLesson(
  slug: string,
  lessonName: string,
  html: string
): Promise<string> {
  const res = await request<{ lesson_id: string }>("POST", `/api/v1/learn/${slug}/lessons`, {
    lesson_name: lessonName,
    html,
  });
  return res.lesson_id;
}

export async function replaceLesson(slug: string, lessonId: string, html: string): Promise<void> {
  await request("PUT", `/api/v1/learn/${slug}/lessons/${lessonId}`, { html });
}

/**
 * Create or replace a reference document. Reference ids are the slugified name
 * with no number prefix, so posting the same `refName` twice updates in place —
 * which is what lets RESOURCES and GLOSSARY be living documents rather than an
 * append-only pile.
 */
export async function writeReference(
  slug: string,
  refName: string,
  html: string
): Promise<string> {
  const res = await request<{ ref_id: string }>("POST", `/api/v1/learn/${slug}/reference`, {
    ref_name: refName,
    html,
  });
  return res.ref_id;
}

export async function addLearningRecord(
  slug: string,
  recordName: string,
  markdown: string
): Promise<string> {
  const res = await request<{ record_id: string }>(
    "POST",
    `/api/v1/learn/${slug}/learning-records`,
    { record_name: recordName, markdown }
  );
  return res.record_id;
}
