import { createHash } from "node:crypto";

/**
 * Pure logic for the vendor-docs-sync mirror strategies —
 * jaewilson07/trigger-dev-workflows#128. Deliberately dependency-free (no
 * `@datacrew/trigger-shared`, no filesystem, no network): this is the half
 * of `vendorDocsMirror.ts` this repo's plain `node --test` harness can run
 * directly, matching `infra-health.ts`'s existing split between
 * tested-pure-logic and untested-I/O-shell. `vendorDocsMirror.ts` (the I/O
 * shell — clone/sync/commit/push/fetch) imports and re-exports everything
 * here rather than duplicating it.
 */

export const VENDOR_DOCS_SYNC_REPO_URL = "https://github.com/jaewilson07/vendor-docs-sync.git";
export const VENDOR_DOCS_SYNC_OWNER = "jaewilson07";
export const VENDOR_DOCS_SYNC_REPO = "vendor-docs-sync";

// ---------------------------------------------------------------------------
// git-mirror source shape (domo-docs, letta-docs, trigger-dev-skills) — pure
// types only; `vendorDocsMirror.ts` owns the actual clone/sync/commit logic.
// ---------------------------------------------------------------------------

export type GitMirrorUpstream = {
  owner: string;
  repo: string;
  /** e.g. "s/article" for domo-docs; omitted => whole repo (letta-docs, trigger-dev-skills). */
  subpath?: string;
};

export type GitMirrorSource = {
  id: string;
  /** Subfolder of vendor-docs-sync this source mirrors into, e.g. "domo-docs". */
  subfolder: string;
  upstream: GitMirrorUpstream;
};

// ---------------------------------------------------------------------------
// Diff-gate — testable against a fixture pair of directory trees. The REAL
// commit gate at runtime is still `git add -A` + `hasStagedChanges`
// (`vendorDocsMirror.ts`, matching `crewRagDomoScrape.ts`) — this function
// exists so "does a content change get detected" has a fast, deterministic
// unit test independent of git plumbing.
// ---------------------------------------------------------------------------

/** relative path -> file content */
export type FileTree = Record<string, string>;

export type TreeDiff = {
  changed: boolean;
  added: string[];
  removed: string[];
  modified: string[];
};

/**
 * Compares two flat `{relativePath: content}` trees. Deterministic, pure —
 * no I/O. `before`/`after` are expected to already exclude anything that
 * should never gate a commit (e.g. `.git/**`, `manifest.json`'s own
 * `last_updated` timestamp field is the caller's concern, not this
 * function's).
 */
export function diffFileTrees(before: FileTree, after: FileTree): TreeDiff {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));

  const added = [...afterKeys].filter((k) => !beforeKeys.has(k)).sort();
  const removed = [...beforeKeys].filter((k) => !afterKeys.has(k)).sort();
  const modified = [...afterKeys]
    .filter((k) => beforeKeys.has(k) && before[k] !== after[k])
    .sort();

  return {
    changed: added.length > 0 || removed.length > 0 || modified.length > 0,
    added,
    removed,
    modified,
  };
}

// ---------------------------------------------------------------------------
// crawl-mirror strategy (claude-code-docs) — ported conceptually from
// ericbuess/claude-code-docs's scripts/fetch_claude_docs.py. This task does
// NOT depend on that repo at runtime; the sitemap-discovery/fetch/validate
// logic below is a from-scratch TypeScript port of its approach.
// ---------------------------------------------------------------------------

/**
 * Tried in order until one responds with a parseable sitemap — mirrors
 * `fetch_claude_docs.py`'s `SITEMAP_URLS` (Anthropic moved Claude Code docs
 * from docs.anthropic.com to code.claude.com; both are tried, oldest-domain
 * fallbacks last).
 */
export const CLAUDE_CODE_DOCS_SITEMAP_CANDIDATES = [
  "https://code.claude.com/docs/sitemap.xml",
  "https://docs.anthropic.com/sitemap.xml",
  "https://docs.anthropic.com/sitemap_index.xml",
  "https://anthropic.com/sitemap.xml",
];

/** New URL structure (code.claude.com) and legacy (docs.anthropic.com) both kept. */
const CLAUDE_CODE_DOCS_INCLUDE_PATTERNS = ["/docs/en/", "/en/docs/claude-code/"];
/** Tool-specific/example/legacy/API-reference pages are not core docs. */
const CLAUDE_CODE_DOCS_EXCLUDE_PATTERNS = ["/tool-use/", "/examples/", "/legacy/", "/api/", "/reference/"];

/** Extracts every `<loc>` URL from a sitemap XML document (regex-based — no XML dependency needed for this shape). */
export function extractSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const loc = match[1]?.trim();
    if (loc) out.push(loc);
  }
  return out;
}

/**
 * Filters a raw sitemap URL list down to Claude Code doc page paths (English
 * only, core docs only), normalizing `.html`/trailing-slash suffixes and
 * de-duplicating. Pure — the highest-risk new logic in this task, per the
 * issue's Testing Decisions, gets its own unit tests.
 */
export function filterClaudeCodeDocsPaths(urls: string[]): string[] {
  const paths = new Set<string>();
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    let pagePath = parsed.pathname;
    if (!CLAUDE_CODE_DOCS_INCLUDE_PATTERNS.some((p) => pagePath.includes(p))) continue;
    if (CLAUDE_CODE_DOCS_EXCLUDE_PATTERNS.some((p) => pagePath.includes(p))) continue;

    if (pagePath.endsWith(".html")) {
      pagePath = pagePath.slice(0, -".html".length);
    } else if (pagePath.endsWith("/") && pagePath.length > 1) {
      pagePath = pagePath.slice(0, -1);
    }
    paths.add(pagePath);
  }
  return [...paths].sort();
}

/**
 * Converts a page path into a flat, filesystem-safe filename — mirrors
 * `url_to_safe_filename`: known prefixes stripped, remaining subdirectories
 * joined with `__` (not nested), always `.md`.
 */
export function claudeCodeDocsPathToFilename(pagePath: string): string {
  const prefixes = ["/docs/en/", "/en/docs/claude-code/", "/docs/claude-code/", "/claude-code/"];
  let rel: string | null = null;
  for (const prefix of prefixes) {
    const idx = pagePath.indexOf(prefix);
    if (idx !== -1) {
      rel = pagePath.slice(idx + prefix.length);
      break;
    }
  }
  if (rel === null) {
    const marker = "claude-code/";
    const idx = pagePath.indexOf(marker);
    rel = idx !== -1 ? pagePath.slice(idx + marker.length) : pagePath;
  }
  rel = rel.replace(/^\/+/, "");

  if (!rel.includes("/")) {
    return rel.endsWith(".md") ? rel : `${rel}.md`;
  }
  const safe = rel.split("/").join("__");
  return safe.endsWith(".md") ? safe : `${safe}.md`;
}

export type MarkdownValidation = { valid: true } | { valid: false; reason: string };

/**
 * Ports `validate_markdown_content`: rejects an HTML error/login page
 * standing in for real markdown, rejects suspiciously short content, and
 * requires a minimum count of real markdown formatting indicators across the
 * first 50 lines (headers, code fences, lists, links, emphasis, quotes) so a
 * plausible-looking-but-wrong page (e.g. a redirect stub) doesn't get
 * ingested as documentation.
 */
export function validateMarkdownContent(content: string): MarkdownValidation {
  if (!content || content.startsWith("<!DOCTYPE") || content.slice(0, 100).includes("<html")) {
    return { valid: false, reason: "received HTML instead of markdown" };
  }
  if (content.trim().length < 50) {
    return { valid: false, reason: `content too short (${content.length} bytes)` };
  }

  const indicators = ["# ", "## ", "### ", "```", "- ", "* ", "1. ", "[", "**", "_", "> "];
  const lines = content.split("\n").slice(0, 50);
  let indicatorCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (indicators.some((ind) => trimmed.startsWith(ind) || line.includes(ind))) {
      indicatorCount += 1;
    }
  }
  if (indicatorCount < 3) {
    return {
      valid: false,
      reason: `content doesn't appear to be markdown (only ${indicatorCount} markdown indicators found)`,
    };
  }
  return { valid: true };
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type ClaudeCodeDocsManifestEntry = {
  original_url: string;
  original_md_url: string;
  hash: string;
  last_updated: string;
};

export type ClaudeCodeDocsManifest = {
  files: Record<string, ClaudeCodeDocsManifestEntry>;
  last_updated: string;
  sitemap_url: string | null;
  base_url: string;
};
