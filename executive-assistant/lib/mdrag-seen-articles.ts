/**
 * mdrag-backed "has this article already been shown?" check, used to dedup
 * the morning brief's topic-search results (jaewilson07/trigger-dev-workflows,
 * user complaint: "I have seen the same articles about domo for sale the last
 * 5 digests" / "find different news").
 *
 * WHY MDRAG AND NOT LOCAL STATE. Trigger.dev worker containers are ephemeral —
 * nothing persists on local disk between scheduled runs, and there is no
 * Trigger.dev-native KV store. mdrag's `documents` collection is already the
 * only persistent store this pipeline can reach: `check-url` answers "have we
 * ingested this URL before" and `ingest/web` durably records "yes, now we
 * have" (both live-verified against `libraries/mdrag/src/interfaces/api/routers/
 * documents/router.py` and `.../ingest/router.py`). Dedup is therefore
 * permanent-by-URL: once a URL is marked seen, it stays excluded from every
 * future brief. No TTL — see `lib/mdrag-topic-search.ts` for the selection
 * logic this backs.
 *
 * Auth mirrors `tasks/output-mdrag-ingest-sources.ts`'s ingest/web call
 * exactly: `Authorization: Bearer ${DATACREW_API_TOKEN}` (same env var, no new
 * secret), same 120s timeout, same fail-soft posture — a transient mdrag
 * hiccup degrades this feature, it never breaks the morning brief.
 */

const MDRAG_CHECK_URL = "https://wiki.datacrew.space/api/v1/documents/check-url";
const MDRAG_INGEST_WEB_URL = "https://wiki.datacrew.space/api/v1/ingest/web";

// Matches output-mdrag-ingest-sources.ts's MDRAG_INGEST_WEB_URL timeout: generous
// headroom for the enqueue request itself (network/auth), not a completion
// budget — /api/v1/ingest/web returns 202 the moment the crawl job is queued.
const MDRAG_REQUEST_TIMEOUT_MS = 120_000;

/** Read `DATACREW_API_TOKEN` once, matching output-mdrag-ingest-sources.ts's pattern. */
export function resolveDatacrewToken(): string {
  return process.env.DATACREW_API_TOKEN ?? "";
}

/**
 * True if a document with this exact `source_url` was already ingested into
 * mdrag (`GET /api/v1/documents/check-url`, which returns a `DocumentSummary`
 * or bare JSON `null`). A non-2xx response or network failure is treated as
 * "not seen" — a transient mdrag hiccup should degrade dedup, not fail the
 * whole brief.
 */
export async function checkUrlSeen(url: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${MDRAG_CHECK_URL}?url=${encodeURIComponent(url)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(MDRAG_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn("mdrag-seen-articles: check-url returned non-2xx, treating as unseen", {
        url,
        status: res.status,
      });
      return false;
    }

    const body: unknown = await res.json();
    return body !== null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("mdrag-seen-articles: check-url failed, treating as unseen", { url, error });
    return false;
  }
}

/**
 * Queue mdrag ingestion for a URL so future briefs treat it as seen (`POST
 * /api/v1/ingest/web`). Fire-and-forget: async on mdrag's side (202 + job id),
 * never throws — a failed enqueue is logged and returns `false` rather than
 * blocking the brief.
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
