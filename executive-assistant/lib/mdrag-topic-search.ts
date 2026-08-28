/**
 * Searches tracked topics via mdrag's `POST /api/v1/primitives/search-providers`
 * (provider="web"), reusing the typed {@link callMdragPrimitive} seam.
 *
 * Previously this spoke the FastMCP `search_web` tool by hand — a JSON-RPC-over-
 * SSE session (`initialize` → `tools/call`) whose markdown-formatted result was
 * then regex-parsed back into structured items. `search-providers` returns the
 * same underlying web/searxng search as structured JSON, so the whole bespoke
 * transport and the markdown parser are gone (trigger-dev-workflows#9, gap 2).
 * Auth, base URL, and error handling now come from `mdrag-primitives.ts`.
 *
 * DEDUP + "WHY THIS IS INTERESTING" BLURB (jaewilson07/mdrag#1034). A
 * slow-moving story (e.g. "Domo acquisition") returns the same top-N results
 * day after day, so the brief repeated the same articles for days ("I have
 * seen the same articles about domo for sale the last 5 digests"). Every
 * over-fetched candidate is classified against mdrag's persisted document
 * store (`lib/mdrag-seen-articles.ts`) into one of three states:
 *
 *   1. NEVER INGESTED       — queue it into mdrag now (`markArticleSeen`,
 *                              `/ingest/web`) so its "why this is interesting"
 *                              annotation (`SummaryAnnotationService`,
 *                              ADR-0017) can be written by mdrag's background
 *                              worker. NOT selected today — the annotation is
 *                              async and essentially never ready this run.
 *   2. INGESTED, NOT READY  — already queued (a prior run's step 1), but its
 *                              `summary` is still null. Skipped again today,
 *                              stays a candidate for a future run.
 *   3. INGESTED, HAS SUMMARY, NOT YET SHOWN
 *                            — ready. Selected for today's brief, carrying
 *                              its `summary` as `blurb`, and recorded into
 *                              the shown-articles ledger so it is permanently
 *                              excluded from every future run (see
 *                              `lib/mdrag-seen-articles.ts`'s "already shown
 *                              tracking" section for the mechanism and its
 *                              documented gap).
 *
 * If `DATACREW_API_TOKEN` is unset, all of this is skipped entirely — the
 * brief still ships, unfiltered and blurb-less, exactly like before #1034.
 *
 * BEHAVIOR CHANGE FROM THE PRE-#1034 DEDUP. Because a freshly-discovered
 * article is never selected the same run it's discovered, and because most
 * over-fetched candidates on any given day ARE freshly discovered, a topic
 * can now legitimately return zero results for one or more days after this
 * ships (nothing has a `summary` yet) before results start appearing once
 * annotations catch up. `exhausted` below reflects this new meaning.
 */
import { callMdragPrimitive } from "./mdrag-primitives.js";
import {
  checkUrlIngested,
  getDocumentDetail,
  getShownArticleDocumentUids,
  markArticleSeen,
  recordShownArticleDocumentUids,
  resolveDatacrewToken,
} from "./mdrag-seen-articles.js";

export type TopicSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  /**
   * The article's own mdrag `document_uid`, set only once it's actually
   * selected for display (mdrag#1034). Consumed by `deliver-mdrag.ts`
   * (Part B) as `configuration.input_document_uids`.
   */
  documentUid?: string;
  /**
   * "Why this is interesting" — the article's mdrag `summary` annotation
   * (`SummaryAnnotationService`, ADR-0017), set only once it's actually
   * selected for display. See this file's header for the readiness gate.
   */
  blurb?: string;
};

export type TopicSearchResult = {
  topic: string;
  results: TopicSearchResultItem[];
  searched_at: string;
  /**
   * True when READY candidates (ingested, summarized, not yet shown) ran out
   * before reaching `maxResultsPerTopic`. Absent/false in the common case,
   * and always absent when dedup itself was skipped (no token). See this
   * file's header "BEHAVIOR CHANGE" note — this is expected to be `true`
   * often, not just on an exhausted slow-moving story.
   */
  exhausted?: boolean;
};

const SEARCH_PROVIDER = "web";
const RESULT_SOURCE = "mdrag/searxng";

/** Coerce one value from an opaque provider-result dict to a trimmed string. */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Over-fetch multiplier: how many raw search candidates to pull relative to
 * how many ready results we actually need, so a topic with several
 * newly-ready articles still has headroom to fill from without being
 * wasteful for one with none.
 */
function overFetchLimit(maxResultsPerTopic: number): number {
  return Math.max(maxResultsPerTopic * 3, maxResultsPerTopic + 10);
}

/** What `classifyCandidate` learned about one URL, keyed by url in the map `searchTrackedTopics` builds. */
type ReadyInfo = { documentUid: string; blurb: string };

/**
 * Pure selection: walk `candidates` in order, keeping only those present in
 * `readyByUrl` (i.e. classified "ready" — ingested, summarized, not yet
 * shown), collecting up to `limit`. Does no I/O — the caller
 * (`searchTrackedTopics`) builds `readyByUrl` via `classifyCandidate` and
 * delegates here so the selection logic itself stays unit-testable without
 * mocking fetch, same contract the pre-#1034 `selectUnseenResults` had.
 */
export function selectReadyResults(
  candidates: TopicSearchResultItem[],
  readyByUrl: Map<string, ReadyInfo>,
  limit: number
): TopicSearchResultItem[] {
  const selected: TopicSearchResultItem[] = [];
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const info = readyByUrl.get(candidate.url);
    if (!info) continue;
    selected.push({ ...candidate, documentUid: info.documentUid, blurb: info.blurb });
  }
  return selected;
}

/**
 * Classify one candidate URL per this file's header state machine. Mutates
 * nothing; the "never ingested" branch's `markArticleSeen` call is the one
 * side effect, fired here (rather than deferred) because every over-fetched
 * candidate needs it queued regardless of whether it ends up selected today.
 */
async function classifyCandidate(
  url: string,
  shownDocumentUids: Set<string>,
  token: string
): Promise<ReadyInfo | null> {
  const ingested = await checkUrlIngested(url, token);
  if (!ingested) {
    const ok = await markArticleSeen(url, token);
    if (!ok) {
      console.warn("mdrag-topic-search: failed to queue never-before-seen article", { url });
    }
    return null;
  }

  if (shownDocumentUids.has(ingested.documentUid)) return null; // already shown in a prior brief

  const detail = await getDocumentDetail(ingested.documentUid, token);
  const blurb = detail?.summary?.trim();
  if (!blurb) return null; // ingested, but not yet summarized

  return { documentUid: ingested.documentUid, blurb };
}

export async function searchTrackedTopics(
  topics: string[],
  maxResultsPerTopic: number
): Promise<TopicSearchResult[]> {
  const token = resolveDatacrewToken();
  if (!token) {
    console.warn(
      "mdrag-topic-search: DATACREW_API_TOKEN not set, skipping seen-article dedup"
    );
  }

  // Loaded once for the whole run, not per topic — the ledger read is two
  // cheap non-LLM calls (check-url + get-document); re-reading it per topic
  // would multiply that for no benefit, since nothing this run can change it
  // until every topic has been classified. See mdrag-seen-articles.ts.
  const shownDocumentUids = token ? await getShownArticleDocumentUids(token) : new Set<string>();
  const newlyShownDocumentUids: string[] = [];

  const results: TopicSearchResult[] = [];
  for (const topic of topics) {
    // mdrag's search-providers declares `results: list[dict]` (each item is a
    // Provider subclass's own model_dump), so hits are opaque here — we read the
    // base title/url/snippet fields present on every ProviderResult.
    const response = await callMdragPrimitive("search-providers", {
      provider: SEARCH_PROVIDER,
      available_providers: [SEARCH_PROVIDER],
      text: topic,
      limit: token ? overFetchLimit(maxResultsPerTopic) : maxResultsPerTopic,
      hydrate: false,
    });
    const candidates: TopicSearchResultItem[] = (response.results ?? [])
      .map((hit) => ({
        title: str(hit.title),
        url: str(hit.url),
        snippet: str(hit.snippet),
        source: RESULT_SOURCE,
      }))
      .filter((item) => item.url);

    if (!token) {
      results.push({
        topic,
        results: candidates.slice(0, maxResultsPerTopic),
        searched_at: new Date().toISOString(),
      });
      continue;
    }

    const readyByUrl = new Map<string, ReadyInfo>();
    for (const candidate of candidates) {
      const info = await classifyCandidate(candidate.url, shownDocumentUids, token);
      if (info) readyByUrl.set(candidate.url, info);
    }

    const items = selectReadyResults(candidates, readyByUrl, maxResultsPerTopic);
    for (const item of items) {
      if (item.documentUid) newlyShownDocumentUids.push(item.documentUid);
    }

    results.push({
      topic,
      results: items,
      searched_at: new Date().toISOString(),
      ...(items.length < maxResultsPerTopic ? { exhausted: true } : {}),
    });
  }

  if (token && newlyShownDocumentUids.length > 0) {
    const updated = Array.from(new Set([...shownDocumentUids, ...newlyShownDocumentUids]));
    const ok = await recordShownArticleDocumentUids(updated, token);
    if (!ok) {
      console.warn("mdrag-topic-search: failed to update shown-articles ledger", {
        newlyShownCount: newlyShownDocumentUids.length,
      });
    }
  }

  return results;
}
