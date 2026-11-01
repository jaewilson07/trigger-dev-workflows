/**
 * Core of `livekit-docs-capture` (trigger-dev-workflows#272): crawl LiveKit's
 * per-section `llms.txt` indexes, fetch each page as markdown (page URL + `.md`),
 * and ingest only pages whose SHA-256 changed since the last run.
 *
 * Pure of Trigger.dev and of ambient env: every I/O is injected so the crawl,
 * the diff and the ingest can be tested without a network.
 */
import { createHash } from "node:crypto";

export const LIVEKIT_DOCS_ORIGIN = "https://docs.livekit.io";
export const LIVEKIT_ROOT_INDEX = `${LIVEKIT_DOCS_ORIGIN}/llms.txt`;
export const LIVEKIT_COLLECTION_NAME = "livekit-docs";

/** url -> sha256 of the markdown last ingested. Carried between runs in the task output. */
export type DocHashes = Record<string, string>;

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Markdown link targets in an llms.txt body that stay on docs.livekit.io, de-duplicated, fragments dropped. */
export function parseIndexLinks(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    let url: URL;
    try {
      url = new URL(m[1]!, LIVEKIT_DOCS_ORIGIN);
    } catch {
      continue;
    }
    if (url.origin !== LIVEKIT_DOCS_ORIGIN) continue;
    url.hash = "";
    seen.add(url.toString());
  }
  return [...seen];
}

export const isIndexUrl = (url: string): boolean => new URL(url).pathname.endsWith("/llms.txt");

/** Clean-markdown URL for a docs page: append `.md` unless it already is one. */
export function markdownUrl(pageUrl: string): string {
  const u = new URL(pageUrl);
  if (u.pathname.endsWith(".md")) return u.toString();
  u.pathname = `${u.pathname.replace(/\/+$/, "")}.md`;
  return u.toString();
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Every page markdown URL reachable from the root index (root links to section indexes; nested indexes are followed once each). */
export async function collectPageUrls(fetcher: Fetcher, rootIndex = LIVEKIT_ROOT_INDEX): Promise<string[]> {
  const pages = new Set<string>();
  const visited = new Set<string>();
  const queue = [rootIndex];
  while (queue.length > 0) {
    const index = queue.shift()!;
    if (visited.has(index)) continue;
    visited.add(index);
    const res = await fetcher(index);
    if (!res.ok) throw new Error(`index ${index} returned ${res.status}`);
    for (const link of parseIndexLinks(await res.text())) {
      if (isIndexUrl(link)) queue.push(link);
      else pages.add(markdownUrl(link));
    }
  }
  return [...pages].sort();
}

export type CaptureResult = {
  hashes: DocHashes;
  ingested: string[];
  unchanged: number;
  failed: Array<{ url: string; error: string }>;
};

export type CaptureDeps = {
  fetcher: Fetcher;
  /** Ingest one page into the collection; throw on failure. */
  ingest: (page: { url: string; title: string; content: string; sha: string }) => Promise<void>;
  concurrency?: number;
};

const titleOf = (md: string, url: string): string =>
  md.match(/^#\s+(.+)$/m)?.[1]?.trim() || new URL(url).pathname;

/**
 * Fetch every page and ingest the ones whose hash differs from `previous`.
 * A page that fails to fetch or ingest keeps its OLD hash so the next run
 * retries it; one bad page never aborts the crawl.
 */
export async function captureLivekitDocs(previous: DocHashes, deps: CaptureDeps): Promise<CaptureResult> {
  const urls = await collectPageUrls(deps.fetcher);
  const result: CaptureResult = { hashes: {}, ingested: [], unchanged: 0, failed: [] };
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++]!;
      try {
        const res = await deps.fetcher(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const content = await res.text();
        const sha = sha256(content);
        if (previous[url] === sha) {
          result.hashes[url] = sha;
          result.unchanged++;
          continue;
        }
        await deps.ingest({ url, title: titleOf(content, url), content, sha });
        result.hashes[url] = sha;
        result.ingested.push(url);
      } catch (error) {
        if (previous[url]) result.hashes[url] = previous[url]!;
        result.failed.push({ url, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: deps.concurrency ?? 4 }, worker));
  return result;
}
