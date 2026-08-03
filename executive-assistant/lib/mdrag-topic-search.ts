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
 */
import { callMdragPrimitive } from "./mdrag-primitives.js";

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
};

const SEARCH_PROVIDER = "web";
const RESULT_SOURCE = "mdrag/searxng";

/** Coerce one value from an opaque provider-result dict to a trimmed string. */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function searchTrackedTopics(
  topics: string[],
  maxResultsPerTopic: number
): Promise<TopicSearchResult[]> {
  const results: TopicSearchResult[] = [];
  for (const topic of topics) {
    // mdrag's search-providers declares `results: list[dict]` (each item is a
    // Provider subclass's own model_dump), so hits are opaque here — we read the
    // base title/url/snippet fields present on every ProviderResult.
    const response = await callMdragPrimitive("search-providers", {
      provider: SEARCH_PROVIDER,
      available_providers: [SEARCH_PROVIDER],
      text: topic,
      limit: maxResultsPerTopic,
      hydrate: false,
    });
    const items: TopicSearchResultItem[] = (response.results ?? [])
      .map((hit) => ({
        title: str(hit.title),
        url: str(hit.url),
        snippet: str(hit.snippet),
        source: RESULT_SOURCE,
      }))
      .filter((item) => item.url);
    results.push({
      topic,
      results: items,
      searched_at: new Date().toISOString(),
    });
  }
  return results;
}
