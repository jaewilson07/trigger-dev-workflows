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
 * DEDUP. A slow-moving story (e.g. "Domo acquisition") returns the same
 * top-N results day after day, so the brief repeated the same articles for
 * days ("I have seen the same articles about domo for sale the last 5
 * digests"). Every candidate is checked against mdrag's persisted document
 * store (`lib/mdrag-seen-articles.ts`, permanent by URL, no TTL) and anything
 * already shown is skipped; whatever's actually selected for today's brief is
 * then marked seen so it never repeats. If `DATACREW_API_TOKEN` is unset,
 * dedup is skipped entirely — the brief still ships, just unfiltered.
 */
import { callMdragPrimitive } from "./mdrag-primitives.js";
import { checkUrlSeen, markArticleSeen, resolveDatacrewToken } from "./mdrag-seen-articles.js";

export type TopicSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

export type TopicSearchResult = {
  topic: string;
  results: TopicSearchResultItem[];
  searched_at: string;
  /**
   * True when unseen candidates ran out before reaching `maxResultsPerTopic`
   * (i.e. every fetched candidate had already been shown in a prior brief).
   * Absent/false in the common case, and always absent when dedup itself was
   * skipped (no token) — there's no honest "exhausted" signal without having
   * checked.
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
 * how many unseen results we actually need, so a mostly-seen topic still has
 * headroom to filter from without being wasteful for a fresh one.
 */
function overFetchLimit(maxResultsPerTopic: number): number {
  return Math.max(maxResultsPerTopic * 3, maxResultsPerTopic + 10);
}

/**
 * Pure selection: walk `candidates` in order, skipping any whose `url` is in
 * `alreadySeen`, collecting up to `limit` unseen items. Does no I/O — the
 * caller (`searchTrackedTopics`) builds `alreadySeen` via `checkUrlSeen` and
 * delegates here so the selection logic itself is unit-testable without
 * mocking fetch.
 */
export function selectUnseenResults(
  candidates: TopicSearchResultItem[],
  alreadySeen: Set<string>,
  limit: number
): TopicSearchResultItem[] {
  const unseen: TopicSearchResultItem[] = [];
  for (const candidate of candidates) {
    if (unseen.length >= limit) break;
    if (alreadySeen.has(candidate.url)) continue;
    unseen.push(candidate);
  }
  return unseen;
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

    const alreadySeen = new Set<string>();
    for (const candidate of candidates) {
      if (await checkUrlSeen(candidate.url, token)) {
        alreadySeen.add(candidate.url);
      }
    }

    const items = selectUnseenResults(candidates, alreadySeen, maxResultsPerTopic);

    await Promise.all(
      items.map(async (item) => {
        const ok = await markArticleSeen(item.url, token);
        if (!ok) {
          console.warn("mdrag-topic-search: failed to mark article seen", { url: item.url });
        }
      })
    );

    results.push({
      topic,
      results: items,
      searched_at: new Date().toISOString(),
      ...(items.length < maxResultsPerTopic ? { exhausted: true } : {}),
    });
  }
  return results;
}
