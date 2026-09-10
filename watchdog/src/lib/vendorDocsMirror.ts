import { cloneRepo, getSecret, pushWithAuth, setSecret } from "@datacrew/trigger-shared";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CLAUDE_CODE_DOCS_SITEMAP_CANDIDATES,
  VENDOR_DOCS_SYNC_REPO,
  VENDOR_DOCS_SYNC_REPO_URL,
  claudeCodeDocsPathToFilename,
  extractSitemapLocs,
  filterClaudeCodeDocsPaths,
  isMirroredMarkdownPath,
  sha256Hex,
  shouldMirrorPath,
  validateMarkdownContent,
} from "./vendorDocsMirrorCore.js";
import type { ClaudeCodeDocsManifest, GitMirrorSource } from "./vendorDocsMirrorCore.js";

/**
 * Mirror strategies for jaewilson07/trigger-dev-workflows#128 — every vendor
 * doc source lands in its own subfolder of `jaewilson07/vendor-docs-sync`
 * (never inside this repo, never ingested straight from a vendor's own
 * upstream repo). Two strategies feed the same shape (mirror into subfolder,
 * commit + push only on a real diff), split by how a source is discovered:
 *
 *   - **git-mirror** (`runGitMirror`): domo-docs, letta-docs,
 *     trigger-dev-skills — the source already lives in an upstream git repo.
 *   - **crawl-mirror** (`runCrawlMirror`): claude-code-docs — no upstream
 *     repo; pages are discovered via Anthropic's own sitemap, ported
 *     conceptually from `ericbuess/claude-code-docs`'s
 *     `scripts/fetch_claude_docs.py` (cited as a design reference only — this
 *     task does not depend on that repo staying maintained).
 *
 * Both call into `syncDirectoryContents` (the actual file mirroring) and the
 * same `git add -A` + `hasStagedChanges` diff-gate `crewRagDomoScrape.ts`
 * already established, so a source that hasn't moved upstream never produces
 * an empty daily commit or a needless mdrag re-ingest (Implementation
 * Decisions, "Idempotency, two layers").
 *
 * This is the I/O half (git/fs/network) — deliberately depends on
 * `@datacrew/trigger-shared`, so it is NOT exercised by this repo's unit
 * test harness (which runs plain compiled `.js` outside the workspace's
 * module-resolution root — see `vendorDocsMirrorCore.ts`'s doc comment).
 * Every pure rule this module relies on (URL filtering, markdown validation,
 * filename mapping, the diff-gate, hashing) lives in `vendorDocsMirrorCore.ts`
 * and IS tested, in `vendorDocsMirrorCore.test.ts` — this file just
 * re-exports them for convenience so callers only need one import path.
 */

export {
  CLAUDE_CODE_DOCS_SITEMAP_CANDIDATES,
  VENDOR_DOCS_SYNC_OWNER,
  VENDOR_DOCS_SYNC_REPO,
  VENDOR_DOCS_SYNC_REPO_URL,
  claudeCodeDocsPathToFilename,
  diffFileTrees,
  extractSitemapLocs,
  filterClaudeCodeDocsPaths,
  isMirroredMarkdownPath,
  sha256Hex,
  shouldMirrorPath,
  validateMarkdownContent,
} from "./vendorDocsMirrorCore.js";
export type {
  ClaudeCodeDocsManifest,
  ClaudeCodeDocsManifestEntry,
  FileTree,
  GitMirrorSource,
  GitMirrorUpstream,
  MarkdownValidation,
  TreeDiff,
} from "./vendorDocsMirrorCore.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Filesystem mirroring (I/O — not unit tested directly, same convention as
// `cloneRepo`/`pushWithAuth` in git-uv.ts: the pure logic in
// `vendorDocsMirrorCore.ts` is what's tested, this is the thin shell around
// it).
// ---------------------------------------------------------------------------

async function listFilesRecursive(
  dir: string,
  exclude: Set<string>,
  include?: (relPath: string) => boolean
): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const entryAbs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryAbs, entryRel);
      } else if (entry.isFile()) {
        if (!include || include(entryRel)) out.push(entryRel);
      }
    }
  }
  await walk(dir, "");
  return out;
}

export type SyncDirectoryOptions = {
  /** Directory basenames never copied/removed, e.g. `.git`. */
  exclude?: string[];
  /**
   * When set, only source files this returns true for are copied (and only
   * those are considered when deciding what stale destination files to
   * remove — see below). Absent means "copy everything", the original
   * behavior.
   */
  include?: (relPath: string) => boolean;
};

/**
 * Mirrors `srcDir`'s content into `destDir`: every file in `srcDir` (that
 * passes `opts.include`, if given) is written into `destDir`, and every
 * matching file in `destDir` NOT present in `srcDir` is removed — a true
 * mirror, not an additive copy, so a file deleted upstream disappears from
 * `vendor-docs-sync/<vendor>/` too rather than accumulating forever.
 *
 * `destFiles` is listed with the SAME `include` filter as `srcFiles`
 * (jaewilson07/trigger-dev-workflows#154's langsmith-docs OOM follow-up):
 * an unfiltered `destFiles` listing would see every already-mirrored
 * non-markdown file as "not in the (filtered) srcFiles set" and delete it on
 * every single run — for a filtered source, "not in scope" is not the same
 * claim as "removed upstream", and only the latter should trigger a delete.
 */
export async function syncDirectoryContents(
  srcDir: string,
  destDir: string,
  opts: SyncDirectoryOptions = {}
): Promise<void> {
  const exclude = new Set(opts.exclude ?? [".git"]);
  await fs.mkdir(destDir, { recursive: true });

  const [srcFiles, destFiles] = await Promise.all([
    listFilesRecursive(srcDir, exclude, opts.include),
    listFilesRecursive(destDir, exclude, opts.include),
  ]);
  const srcFileSet = new Set(srcFiles);

  for (const rel of srcFiles) {
    const from = path.join(srcDir, rel);
    const to = path.join(destDir, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }

  for (const rel of destFiles) {
    if (!srcFileSet.has(rel)) {
      await fs.rm(path.join(destDir, rel), { force: true });
    }
  }

  // Prune now-empty directories left behind by removed files (deepest first).
  await pruneEmptyDirs(destDir, exclude);
}

async function pruneEmptyDirs(dir: string, exclude: Set<string>): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  let allEmpty = true;
  for (const entry of entries) {
    if (exclude.has(entry.name)) {
      allEmpty = false;
      continue;
    }
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const childEmpty = await pruneEmptyDirs(abs, exclude);
      if (childEmpty) {
        await fs.rmdir(abs).catch(() => {});
      } else {
        allEmpty = false;
      }
    } else {
      allEmpty = false;
    }
  }
  return allEmpty;
}

// ---------------------------------------------------------------------------
// git plumbing — same pattern as `crewRagDomoScrape.ts`'s `runGit`/
// `hasStagedChanges` (redacts argv-inclusive execFile errors, treats
// `git diff --cached --quiet`'s exit 1 as signal, not failure).
// ---------------------------------------------------------------------------

export async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    const sanitized = new Error(
      `git ${args[0]} failed: ${(err.stderr || err.stdout || "no output captured").trim()}`
    ) as Error & { code?: number };
    if (typeof err.code === "number") sanitized.code = err.code;
    throw sanitized;
  }
}

export async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ["diff", "--cached", "--quiet"]);
    return false;
  } catch (error) {
    if ((error as { code?: number }).code === 1) {
      return true;
    }
    throw error;
  }
}

async function ensureGitIdentity(cwd: string): Promise<void> {
  await runGit(cwd, ["config", "user.name", "github-actions[bot]"]);
  await runGit(cwd, ["config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
}

export type MirrorCommitResult = {
  changed: boolean;
  commitSha: string | null;
};

/**
 * Stages `subfolder` inside `vendorDocsSyncDir`, and — only if that produced
 * a real diff — commits and pushes it to `main`. Shared tail end of both
 * mirror strategies.
 */
async function commitAndPushIfChanged(
  vendorDocsSyncDir: string,
  subfolder: string,
  commitMessage: string,
  ghToken: string
): Promise<MirrorCommitResult> {
  await ensureGitIdentity(vendorDocsSyncDir);
  await runGit(vendorDocsSyncDir, ["add", "-A", "--", subfolder]);

  if (!(await hasStagedChanges(vendorDocsSyncDir))) {
    return { changed: false, commitSha: null };
  }

  await runGit(vendorDocsSyncDir, ["commit", "-m", commitMessage]);
  await pushWithAuth(vendorDocsSyncDir, "origin", "HEAD:main", ghToken);
  const { stdout: commitSha } = await runGit(vendorDocsSyncDir, ["rev-parse", "HEAD"]);
  return { changed: true, commitSha };
}

// ---------------------------------------------------------------------------
// git-mirror strategy (domo-docs, letta-docs, trigger-dev-skills)
// ---------------------------------------------------------------------------

/**
 * Clones `source.upstream` (public repo, no auth needed for the read side),
 * mirrors it (or its `subpath` subtree) into
 * `vendorDocsSyncDir/<source.subfolder>`, and commits + pushes only if the
 * mirrored content actually changed.
 *
 * `ghToken` authenticates the PUSH to `vendor-docs-sync` (a private repo);
 * the upstream clone is always public and unauthenticated — matching the
 * upstream repos' own current direct-ingest visibility.
 */
export async function runGitMirror(
  source: GitMirrorSource,
  vendorDocsSyncDir: string,
  ghToken: string
): Promise<MirrorCommitResult> {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), `vendor-docs-${source.id}-`));
  try {
    const upstreamDir = path.join(scratchRoot, "upstream");
    const upstreamUrl = `https://github.com/${source.upstream.owner}/${source.upstream.repo}.git`;
    await cloneRepo(upstreamUrl, upstreamDir);

    const contentDir = source.upstream.subpath
      ? path.join(upstreamDir, source.upstream.subpath)
      : upstreamDir;
    const destDir = path.join(vendorDocsSyncDir, source.subfolder);

    // Markdown-only, further narrowed by any excludeSubpaths — see
    // isMirroredMarkdownPath's and shouldMirrorPath's doc comments
    // (jaewilson07/trigger-dev-workflows#154): every non-markdown byte here
    // was already dead weight (mdrag's ingest never reads it), and on
    // langsmith-docs it was ~490MB of it, enough to OOM-kill the push.
    const excludeSubpaths = source.upstream.excludeSubpaths ?? [];
    await syncDirectoryContents(contentDir, destDir, {
      exclude: [".git"],
      include: (relPath) => shouldMirrorPath(relPath, excludeSubpaths),
    });

    const dateStamp = new Date().toISOString().slice(0, 10);
    return await commitAndPushIfChanged(
      vendorDocsSyncDir,
      source.subfolder,
      `chore(${source.subfolder}): mirror ${source.upstream.owner}/${source.upstream.repo} ${dateStamp} [skip ci]`,
      ghToken
    );
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// crawl-mirror strategy (claude-code-docs) runtime path — pure rules
// (sitemap URL filtering, markdown validation, filename mapping) live in
// vendorDocsMirrorCore.ts; this is the fetch/retry/write orchestration
// around them.
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;
const RATE_LIMIT_DELAY_MS = 500;

/** Tries each sitemap candidate in turn; returns the first that parses with at least one `<loc>`. */
async function discoverSitemap(): Promise<{ sitemapUrl: string; baseUrl: string; locs: string[] } | null> {
  for (const sitemapUrl of CLAUDE_CODE_DOCS_SITEMAP_CANDIDATES) {
    try {
      const res = await fetch(sitemapUrl, {
        headers: { "User-Agent": "datacrew-watchdog-claude-code-docs-ingest" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const locs = extractSitemapLocs(xml);
      if (locs.length === 0) continue;
      const baseUrl = new URL(locs[0]!).origin;
      return { sitemapUrl, baseUrl, locs };
    } catch {
      continue;
    }
  }
  return null;
}

/** Fetches one page's markdown with 429-aware exponential backoff + jitter, then validates it. */
async function fetchMarkdownPage(baseUrl: string, pagePath: string): Promise<string> {
  const url = `${baseUrl}${pagePath}.md`;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "datacrew-watchdog-claude-code-docs-ingest" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1_000);
        continue;
      }
      if (!res.ok) {
        throw new Error(`${res.status} fetching ${url}`);
      }
      const content = await res.text();
      const validation = validateMarkdownContent(content);
      if (!validation.valid) {
        throw new Error(`validation failed for ${pagePath}: ${validation.reason}`);
      }
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES - 1) {
        const delay = Math.min(RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
        await sleep(delay * (0.5 + Math.random() * 0.5));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`failed to fetch ${url}`);
}

export type CrawlMirrorOutcome = MirrorCommitResult & {
  pagesDiscovered: number;
  pagesFetched: number;
  pagesFailed: number;
  failedPaths: string[];
};

/**
 * Discovers Claude Code doc pages via Anthropic's sitemap, fetches +
 * validates each as markdown, writes them (flat, `__`-joined filenames) plus
 * a `manifest.json` (source URL + hash per doc) into
 * `vendorDocsSyncDir/claude-code-docs/`, and commits + pushes only on a real
 * diff. Partial failure (some pages 404/invalid) is not fatal — matching the
 * reference script, only a zero-success run is treated as a hard failure.
 */
export async function runCrawlMirror(
  vendorDocsSyncDir: string,
  ghToken: string
): Promise<CrawlMirrorOutcome> {
  const subfolder = "claude-code-docs";
  const destDir = path.join(vendorDocsSyncDir, subfolder);
  await fs.mkdir(destDir, { recursive: true });

  const discovery = await discoverSitemap();
  if (!discovery) {
    throw new Error("could not discover a Claude Code docs sitemap from any candidate URL");
  }
  const { sitemapUrl, baseUrl, locs } = discovery;
  const pagePaths = filterClaudeCodeDocsPaths(locs);

  const manifest: ClaudeCodeDocsManifest = {
    files: {},
    last_updated: new Date().toISOString(),
    sitemap_url: sitemapUrl,
    base_url: baseUrl,
  };

  const fetchedFilenames = new Set<string>();
  const failedPaths: string[] = [];
  let fetchedCount = 0;

  for (let i = 0; i < pagePaths.length; i++) {
    const pagePath = pagePaths[i]!;
    const filename = claudeCodeDocsPathToFilename(pagePath);
    try {
      const content = await fetchMarkdownPage(baseUrl, pagePath);
      await fs.writeFile(path.join(destDir, filename), content, "utf8");
      manifest.files[filename] = {
        original_url: `${baseUrl}${pagePath}`,
        original_md_url: `${baseUrl}${pagePath}.md`,
        hash: sha256Hex(content),
        last_updated: manifest.last_updated,
      };
      fetchedFilenames.add(filename);
      fetchedCount += 1;
    } catch (error) {
      failedPaths.push(pagePath);
    }
    if (i < pagePaths.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  if (fetchedCount === 0) {
    throw new Error(
      `claude-code-docs crawl-mirror fetched 0/${pagePaths.length} pages successfully (sitemap: ${sitemapUrl})`
    );
  }

  // Remove files this run no longer discovered (obsolete pages), mirroring
  // `cleanup_old_files` — but never the manifest itself, and only within
  // this subfolder.
  const existing = await listFilesRecursive(destDir, new Set([".git"]));
  for (const rel of existing) {
    if (rel === "manifest.json" || rel === "README.md") continue;
    if (!fetchedFilenames.has(rel)) {
      await fs.rm(path.join(destDir, rel), { force: true });
    }
  }

  await fs.writeFile(path.join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const dateStamp = new Date().toISOString().slice(0, 10);
  const commitResult = await commitAndPushIfChanged(
    vendorDocsSyncDir,
    subfolder,
    `chore(${subfolder}): mirror Claude Code docs ${dateStamp} [skip ci]`,
    ghToken
  );

  return {
    ...commitResult,
    pagesDiscovered: pagePaths.length,
    pagesFetched: fetchedCount,
    pagesFailed: failedPaths.length,
    failedPaths,
  };
}

// ---------------------------------------------------------------------------
// Shared: clone vendor-docs-sync itself
// ---------------------------------------------------------------------------

/** Clones `jaewilson07/vendor-docs-sync` (private — needs `ghToken`) into a fresh scratch dir. Caller owns cleanup. */
export async function cloneVendorDocsSync(ghToken: string): Promise<string> {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vendor-docs-sync-"));
  const dest = path.join(scratchRoot, VENDOR_DOCS_SYNC_REPO);
  await cloneRepo(VENDOR_DOCS_SYNC_REPO_URL, dest, ghToken);
  return dest;
}

// ---------------------------------------------------------------------------
// Shared: stale-cleanup "already done" flag (code review on #129 — the
// cutover cleanup was running every scheduled run instead of the spec's
// "one-time, after first successful vendor-docs-sync-sourced ingest")
// ---------------------------------------------------------------------------

const STALE_CLEANUP_SECRET_PATH = "/datacrew";

/**
 * Durable per-source flag, same shape as `domoDocsReport.ts`'s
 * `SHA_CACHE_KEY` — Infisical is the one thing every task here already
 * authenticates to and trusts for a small persisted value, and a Trigger.dev
 * container has no durable filesystem of its own across runs.
 */
function staleCleanupDoneKey(sourceId: string): string {
  return `VENDOR_DOCS_STALE_CLEANUP_DONE_${sourceId.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * `false` on "no flag yet" AND on a read failure — both mean "cleanup has
 * not been confirmed done", which is the safe default (a spurious retry of
 * an idempotent cleanup costs a list call; skipping a needed one leaves
 * stale documents behind indefinitely).
 */
export async function isStaleCleanupDone(sourceId: string): Promise<boolean> {
  try {
    const value = await getSecret(staleCleanupDoneKey(sourceId), {
      path: STALE_CLEANUP_SECRET_PATH,
      recursive: false,
    });
    return value === "true";
  } catch {
    return false;
  }
}

/** Call only after a LIVE (non-dry-run) cleanup pass returns without throwing — see `runVendorDocsGitMirrorTask`. */
export async function markStaleCleanupDone(sourceId: string): Promise<void> {
  await setSecret(staleCleanupDoneKey(sourceId), "true", {
    path: STALE_CLEANUP_SECRET_PATH,
    mode: "upsert",
  });
}
