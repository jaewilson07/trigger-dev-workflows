/**
 * mdrag-backed article lifecycle for the morning brief's topic-search dedup
 * (jaewilson07/trigger-dev-workflows, user complaint: "I have seen the same
 * articles about domo for sale the last 5 digests" / "find different news"),
 * now split into two decoupled states per jaewilson07/mdrag#1034:
 *
 *   INGESTED   — this URL has been queued into mdrag at least once
 *                (`checkUrlIngested`/`markArticleSeen`). Permanent, no TTL.
 *   SHOWN      — this URL's article was actually displayed in a brief.
 *                Permanent, tracked via `getShownArticleDocumentUids`/
 *                `recordShownArticleDocumentUids` — see that pair's doc
 *                comment for the mechanism and its known gap.
 *
 * WHY THE SPLIT. `SummaryAnnotationService` (mdrag's existing "why this is
 * interesting" annotation, already live) writes a document's `summary` field
 * ASYNCHRONOUSLY, after ingest, via a background worker — essentially never
 * ready the same run an article is first ingested (live-verified via
 * `output-mdrag-ingest.ts`'s note: even the synchronous `/ingest/text`
 * annotation path alone can take 60-70s on a cold model; the *worker* path
 * `/ingest/web` uses here is not on any request's clock at all, so there is
 * no guaranteed turnaround). Before this split, "ingested" and "shown" were
 * the same event (see the original dedup commit), which meant an article was
 * shown once, immediately, with no blurb (summary never ready in time), then
 * permanently excluded — it could never gain a "why this is interesting"
 * blurb. Decoupling lets an article sit as "ingested, not yet shown" for
 * however many days its annotation takes, then be shown WITH its blurb the
 * first day `summary` is non-null. See `lib/mdrag-topic-search.ts` for the
 * selection logic this backs.
 *
 * WHY MDRAG AND NOT LOCAL STATE. Trigger.dev worker containers are ephemeral —
 * nothing persists on local disk between scheduled runs, and there is no
 * Trigger.dev-native KV store. mdrag's `documents` collection is the only
 * persistent store this pipeline can reach.
 *
 * Auth mirrors `tasks/output-mdrag-ingest-sources.ts`'s ingest/web call
 * exactly: `Authorization: Bearer ${DATACREW_API_TOKEN}` (same env var, no new
 * secret), same 120s timeout, same fail-soft posture — a transient mdrag
 * hiccup degrades this feature, it never breaks the morning brief.
 *
 * HAND-WRITTEN TYPES, NOT `lib/mdrag-schema.ts`. That file is OpenAPI-generated
 * from mdrag's `/primitives/*` surface only (see its own header) and has never
 * covered `/documents/*` or `/ingest/*` — this predates mdrag#1034 and isn't
 * something `npm run generate:mdrag-types` will change. The response shapes
 * below are hand-verified against mdrag's `interfaces/api/routers/documents/
 * models.py` (`document_uid`, `summary`) plus the `configuration` field
 * mdrag#1034 adds to `GET /documents/{document_uid}` (not live until that
 * issue deploys — build against the documented contract, verify live after).
 */

import { pollMdragJob, type MdragJobEnqueueResponse } from "./mdrag-job-poll.js";

const MDRAG_BASE_URL = "https://wiki.datacrew.space";
const MDRAG_CHECK_URL = `${MDRAG_BASE_URL}/api/v1/documents/check-url`;
const MDRAG_DOCUMENT_URL = `${MDRAG_BASE_URL}/api/v1/documents`;
const MDRAG_INGEST_WEB_URL = `${MDRAG_BASE_URL}/api/v1/ingest/web`;
const MDRAG_INGEST_TEXT_URL = `${MDRAG_BASE_URL}/api/v1/ingest/text`;

// Matches output-mdrag-ingest-sources.ts's MDRAG_INGEST_WEB_URL timeout: generous
// headroom for the enqueue request itself (network/auth), not a completion
// budget — /api/v1/ingest/web returns 202 the moment the crawl job is queued.
const MDRAG_REQUEST_TIMEOUT_MS = 120_000;

/** Read `DATACREW_API_TOKEN` once, matching output-mdrag-ingest-sources.ts's pattern. */
export function resolveDatacrewToken(): string {
  return process.env.DATACREW_API_TOKEN ?? "";
}

/**
 * A document previously ingested at this exact `source_url`, as returned by
 * `GET /documents/check-url` (`DocumentSummary | null` — hand-verified field
 * name against `documents/models.py`; only `document_uid` is used here).
 */
type CheckUrlResult = { documentUid: string } | null;

/**
 * True if a document with this exact `source_url` was already ingested into
 * mdrag (`GET /api/v1/documents/check-url`), and if so, its `document_uid`.
 * A non-2xx response or network failure is treated as "not ingested" — a
 * transient mdrag hiccup should degrade dedup, not fail the whole brief.
 */
export async function checkUrlIngested(url: string, token: string): Promise<CheckUrlResult> {
  try {
    const res = await fetch(`${MDRAG_CHECK_URL}?url=${encodeURIComponent(url)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(MDRAG_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn("mdrag-seen-articles: check-url returned non-2xx, treating as not ingested", {
        url,
        status: res.status,
      });
      return null;
    }

    const body = (await res.json()) as { document_uid?: string } | null;
    if (!body || !body.document_uid) return null;
    return { documentUid: body.document_uid };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("mdrag-seen-articles: check-url failed, treating as not ingested", { url, error });
    return null;
  }
}

/**
 * Queue mdrag ingestion for a URL so it becomes a candidate for a FUTURE
 * brief once its summary annotation lands (`POST /api/v1/ingest/web`).
 * Fire-and-forget: async on mdrag's side (202 + job id), never throws — a
 * failed enqueue is logged and returns `false` rather than blocking the
 * brief. Does NOT mean "shown" — see this module's header.
 */
export async function markArticleSeen(url: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(MDRAG_INGEST_WEB_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(MDRAG_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn("mdrag-seen-articles: ingest/web enqueue failed", {
        url,
        status: res.status,
      });
      return false;
    }

    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("mdrag-seen-articles: ingest/web enqueue failed", { url, error });
    return false;
  }
}

/** `GET /documents/{document_uid}`'s fields this module reads. */
type DocumentDetailResult = {
  /** Null until mdrag's save-worker has summarized it (ADR-0017). */
  summary: string | null;
  /** mdrag#1034 — mirrors `metadata.configuration` at ingest time, or null. */
  configuration: Record<string, unknown> | null;
} | null;

/**
 * Fetch a document's detail view (`GET /api/v1/documents/{document_uid}`) —
 * used two ways here: reading a candidate article's `summary` (the "why this
 * is interesting" blurb, once ready), and reading the shown-articles ledger
 * document's `configuration` (see `getShownArticleDocumentUids` below). A
 * non-2xx response or network failure returns `null`, same fail-soft posture
 * as `checkUrlIngested` — a transient hiccup means "treat as not ready /
 * nothing recorded yet," not a broken brief.
 */
export async function getDocumentDetail(documentUid: string, token: string): Promise<DocumentDetailResult> {
  try {
    const res = await fetch(`${MDRAG_DOCUMENT_URL}/${encodeURIComponent(documentUid)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(MDRAG_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn("mdrag-seen-articles: get-document returned non-2xx", {
        documentUid,
        status: res.status,
      });
      return null;
    }

    const body = (await res.json()) as { summary?: string | null; configuration?: Record<string, unknown> | null };
    return {
      summary: body.summary ?? null,
      configuration: body.configuration ?? null,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("mdrag-seen-articles: get-document failed", { documentUid, error });
    return null;
  }
}

// ── "Already shown" tracking ────────────────────────────────────────────
//
// mdrag exposes no generic per-document flag today (confirmed against
// mdrag#1034's own scope: `PATCH /documents/{uid}/metadata` only supports
// `context_url`, and `WebIngestRequest` — what ingests an article's own
// document — is explicitly OUT of scope for the new `metadata` field, so an
// article's own document can never carry a "shown" marker). The mechanism
// chosen here instead: ONE stable, upserted "ledger" document, ingested via
// `POST /ingest/text` (which mdrag#1034 DOES give a `metadata.configuration`
// field, and which mdrag's ingestion pipeline is documented as upserting by
// `source_url`, not appending — see `capabilities/ingestion/ingest.py`:
// "ingestion is additive + idempotent (upsert by source_url)"). Every run:
// read the ledger's `configuration.shown_article_document_uids` ONCE
// (`getShownArticleDocumentUids`, two cheap non-LLM calls: check-url + get-
// document), and if this run shows anything new, upsert the ledger with the
// union (`recordShownArticleDocumentUids`, one `/ingest/text` call —
// async_mode as of mdrag#1043, so the save-time summary annotation cost,
// ADR-0017, is paid off this call's own clock; see that function's own doc
// comment).
//
// KNOWN GAP (flagged per this task's own instructions, not silently
// accepted): this is read-modify-write, not atomic. Two overlapping runs
// racing to update the ledger could each read the same starting set and one
// write could clobber the other's addition — for a single daily cron this is
// a low-probability, low-blast-radius gap (worst case: one article is
// eligible to be re-shown once, on a later day, before its uid re-enters the
// ledger on the next successful write). Also: the ledger is capped
// (`MDRAG_SHOWN_LEDGER_CAP`) to bound payload size; an article shown so long
// ago its uid has rolled off the cap could theoretically resurface as a
// "new" candidate and be re-shown. Given the cap (5000 — years of daily
// briefs at realistic article-per-day volumes) this is a deliberately
// accepted, not fixed, edge case — a human should decide if it's acceptable.

const MDRAG_SHOWN_LEDGER_SOURCE_URL = "mdrag-digest-ledger://morning-brief/shown-articles";
const MDRAG_SHOWN_LEDGER_CAP = 5000;

/**
 * The full set of article `document_uid`s ever shown in a morning brief, per
 * the shown-articles ledger document (see the section header above). Empty
 * set if the ledger hasn't been created yet (first run) or on any failure —
 * fail-soft, same posture as everything else in this module.
 */
export async function getShownArticleDocumentUids(token: string): Promise<Set<string>> {
  const ledger = await checkUrlIngested(MDRAG_SHOWN_LEDGER_SOURCE_URL, token);
  if (!ledger) return new Set();

  const detail = await getDocumentDetail(ledger.documentUid, token);
  const raw = detail?.configuration?.["shown_article_document_uids"];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

/**
 * Upsert the shown-articles ledger document with `shownDocumentUids` (the
 * FULL set to persist — callers pass the union of what was already recorded
 * plus whatever this run newly showed, not a delta). Capped to the most
 * recent `MDRAG_SHOWN_LEDGER_CAP` entries — see the known-gap note above.
 * Fail-soft: returns `false` and logs rather than throwing, so a ledger-write
 * hiccup degrades future dedup, it never breaks today's brief.
 *
 * MIGRATED TO async_mode 2026-08-13 (jaewilson07/mdrag#1043): this used to
 * POST synchronously (paying the full save-time summary Annotation tax the
 * section header above documents) with a 120s timeout as a stopgap against
 * that call running long on a cold model. Now enqueues and polls to a
 * terminal state instead — see `lib/mdrag-job-poll.ts`'s header.
 */
export async function recordShownArticleDocumentUids(
  shownDocumentUids: string[],
  token: string
): Promise<boolean> {
  const capped = shownDocumentUids.slice(-MDRAG_SHOWN_LEDGER_CAP);
  try {
    const res = await fetch(MDRAG_INGEST_TEXT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content:
          `Morning-brief shown-articles ledger. ${capped.length} article document(s) ever ` +
          `displayed in a brief, most-recently-shown last. Machine-maintained by ` +
          `lib/mdrag-seen-articles.ts — do not edit by hand. Last updated ${new Date().toISOString()}.`,
        source_url: MDRAG_SHOWN_LEDGER_SOURCE_URL,
        source_title: "Morning Brief — shown-articles ledger",
        // mdrag#1034: merged onto the stored document's metadata; content_hash
        // stays server-set regardless of what's under this key.
        metadata: { configuration: { shown_article_document_uids: capped } },
        async_mode: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn("mdrag-seen-articles: shown-ledger upsert failed", {
        status: res.status,
        count: capped.length,
      });
      return false;
    }

    const job = (await res.json()) as MdragJobEnqueueResponse;
    const jobResult = await pollMdragJob(MDRAG_BASE_URL, job.status_url, token);
    if (!jobResult.ok) {
      console.warn("mdrag-seen-articles: shown-ledger upsert job failed", {
        error: jobResult.error,
        count: capped.length,
      });
      return false;
    }

    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("mdrag-seen-articles: shown-ledger upsert failed", { error, count: capped.length });
    return false;
  }
}
