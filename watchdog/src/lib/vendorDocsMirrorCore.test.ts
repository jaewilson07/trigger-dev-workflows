import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeCodeDocsPathToFilename,
  diffFileTrees,
  extractSitemapLocs,
  filterClaudeCodeDocsPaths,
  isMirroredMarkdownPath,
  sha256Hex,
  validateMarkdownContent,
} from "./vendorDocsMirrorCore.js";
import type { FileTree } from "./vendorDocsMirrorCore.js";

// ---------------------------------------------------------------------------
// Diff-gate: a fixture pair of "before"/"after" directory trees, per the
// issue's Testing Decisions ("The git-mirror step's diff-gate ... gets its
// own test against a fixture pair of before and after directory trees").
// ---------------------------------------------------------------------------

const beforeTree: FileTree = {
  "README.md": "# Domo docs\n",
  "getting-started.md": "old content",
  "reference/api.md": "unchanged",
};

test("identical trees produce no diff", () => {
  const result = diffFileTrees(beforeTree, { ...beforeTree });
  assert.deepEqual(result, { changed: false, added: [], removed: [], modified: [] });
});

test("a modified file is detected and named", () => {
  const after: FileTree = { ...beforeTree, "getting-started.md": "new content" };
  const result = diffFileTrees(beforeTree, after);
  assert.equal(result.changed, true);
  assert.deepEqual(result.modified, ["getting-started.md"]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
});

test("an added file is detected and named", () => {
  const after: FileTree = { ...beforeTree, "new-page.md": "content" };
  const result = diffFileTrees(beforeTree, after);
  assert.equal(result.changed, true);
  assert.deepEqual(result.added, ["new-page.md"]);
});

test("a removed file (upstream deleted it) is detected and named", () => {
  const after: FileTree = { "README.md": beforeTree["README.md"]!, "reference/api.md": beforeTree["reference/api.md"]! };
  const result = diffFileTrees(beforeTree, after);
  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ["getting-started.md"]);
});

test("added + removed + modified all surface together, sorted", () => {
  const after: FileTree = {
    "README.md": "# Domo docs\n",
    "getting-started.md": "new content",
    "brand-new.md": "hello",
    "also-new.md": "world",
  };
  const result = diffFileTrees(beforeTree, after);
  assert.equal(result.changed, true);
  assert.deepEqual(result.added, ["also-new.md", "brand-new.md"]);
  assert.deepEqual(result.removed, ["reference/api.md"]);
  assert.deepEqual(result.modified, ["getting-started.md"]);
});

test("an empty tree against itself never gates a commit", () => {
  assert.equal(diffFileTrees({}, {}).changed, false);
});

// ---------------------------------------------------------------------------
// claude-code-docs URL filtering — the highest-risk new code, per Testing
// Decisions, gets its own tests for the include/exclude rules.
// ---------------------------------------------------------------------------

test("keeps /docs/en/ (new structure) pages", () => {
  const result = filterClaudeCodeDocsPaths(["https://code.claude.com/docs/en/overview"]);
  assert.deepEqual(result, ["/docs/en/overview"]);
});

test("keeps /en/docs/claude-code/ (legacy structure) pages", () => {
  const result = filterClaudeCodeDocsPaths(["https://docs.anthropic.com/en/docs/claude-code/hooks"]);
  assert.deepEqual(result, ["/en/docs/claude-code/hooks"]);
});

test("drops pages outside both include patterns", () => {
  const result = filterClaudeCodeDocsPaths([
    "https://anthropic.com/pricing",
    "https://code.claude.com/blog/announcement",
  ]);
  assert.deepEqual(result, []);
});

for (const excluded of ["tool-use", "examples", "legacy", "api", "reference"]) {
  test(`excludes /${excluded}/ pages even under /docs/en/`, () => {
    const result = filterClaudeCodeDocsPaths([`https://code.claude.com/docs/en/${excluded}/something`]);
    assert.deepEqual(result, []);
  });
}

test("strips .html and trailing slash, and de-duplicates", () => {
  const result = filterClaudeCodeDocsPaths([
    "https://code.claude.com/docs/en/hooks.html",
    "https://code.claude.com/docs/en/hooks/",
    "https://code.claude.com/docs/en/hooks",
  ]);
  assert.deepEqual(result, ["/docs/en/hooks"]);
});

test("sorts the result deterministically", () => {
  const result = filterClaudeCodeDocsPaths([
    "https://code.claude.com/docs/en/zeta",
    "https://code.claude.com/docs/en/alpha",
  ]);
  assert.deepEqual(result, ["/docs/en/alpha", "/docs/en/zeta"]);
});

test("an unparseable URL is skipped, not thrown", () => {
  assert.doesNotThrow(() => filterClaudeCodeDocsPaths(["not a url", "https://code.claude.com/docs/en/ok"]));
  assert.deepEqual(filterClaudeCodeDocsPaths(["not a url", "https://code.claude.com/docs/en/ok"]), [
    "/docs/en/ok",
  ]);
});

// ---------------------------------------------------------------------------
// Filename mapping
// ---------------------------------------------------------------------------

test("a top-level page path becomes a flat .md filename", () => {
  assert.equal(claudeCodeDocsPathToFilename("/docs/en/overview"), "overview.md");
});

test("a nested page path is joined with __, not nested directories", () => {
  assert.equal(claudeCodeDocsPathToFilename("/docs/en/advanced/setup"), "advanced__setup.md");
});

test("the legacy prefix is also stripped correctly", () => {
  assert.equal(claudeCodeDocsPathToFilename("/en/docs/claude-code/hooks"), "hooks.md");
});

// ---------------------------------------------------------------------------
// Markdown-content validation — the other highest-risk new logic.
// ---------------------------------------------------------------------------

test("real-looking markdown validates", () => {
  const content = [
    "# Claude Code Overview",
    "",
    "Claude Code is an [agentic tool](https://claude.com) for your terminal.",
    "",
    "## Installation",
    "",
    "```bash",
    "npm install -g @anthropic-ai/claude-code",
    "```",
    "",
    "- Fast",
    "- Local",
  ].join("\n");
  assert.deepEqual(validateMarkdownContent(content), { valid: true });
});

test("an HTML error/login page is rejected, not ingested as documentation", () => {
  const html = "<!DOCTYPE html><html><head><title>Sign in</title></head><body></body></html>";
  const result = validateMarkdownContent(html);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /HTML/);
});

test("content with <html> early but no leading DOCTYPE is also rejected", () => {
  const html = "<html><body>oops</body></html>" + "x".repeat(100);
  const result = validateMarkdownContent(html);
  assert.equal(result.valid, false);
});

test("suspiciously short content is rejected", () => {
  const result = validateMarkdownContent("nope");
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /too short/);
});

test("plain prose with no markdown formatting is rejected", () => {
  const prose = "This is just a sentence repeated many times without any markdown formatting at all here today.";
  const result = validateMarkdownContent(prose.repeat(2));
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /doesn't appear to be markdown/);
});

test("empty content is rejected", () => {
  assert.equal(validateMarkdownContent("").valid, false);
});

// ---------------------------------------------------------------------------
// Sitemap <loc> extraction + hashing (used by the crawl-mirror runtime path)
// ---------------------------------------------------------------------------

test("extracts every <loc> from a sitemap document", () => {
  const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://code.claude.com/docs/en/overview</loc></url>
  <url><loc>https://code.claude.com/docs/en/setup</loc></url>
</urlset>`;
  assert.deepEqual(extractSitemapLocs(xml), [
    "https://code.claude.com/docs/en/overview",
    "https://code.claude.com/docs/en/setup",
  ]);
});

test("an empty or malformed sitemap yields no locs, not a throw", () => {
  assert.deepEqual(extractSitemapLocs("<urlset></urlset>"), []);
  assert.deepEqual(extractSitemapLocs("not xml at all"), []);
});

test("sha256Hex is deterministic and content-sensitive", () => {
  const a = sha256Hex("hello world");
  const b = sha256Hex("hello world");
  const c = sha256Hex("hello world!");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

// ---------------------------------------------------------------------------
// isMirroredMarkdownPath — jaewilson07/trigger-dev-workflows#154. Keeps
// git-mirror sources from pushing non-markdown assets (screenshots, gifs,
// video) into vendor-docs-sync; mdrag's ingest never reads them, and on
// langsmith-docs they were large enough (~490MB) to OOM-kill the git push.
// ---------------------------------------------------------------------------

test("keeps .md and .mdx files, case-insensitively", () => {
  assert.equal(isMirroredMarkdownPath("oss/langchain/overview.mdx"), true);
  assert.equal(isMirroredMarkdownPath("README.md"), true);
  assert.equal(isMirroredMarkdownPath("nested/dir/file.MDX"), true);
  assert.equal(isMirroredMarkdownPath("nested/dir/file.Md"), true);
});

test("drops the exact asset types that blew up langsmith-docs' push", () => {
  for (const relPath of [
    "langsmith/screenshots/dashboard.png",
    "langsmith/walkthroughs/setup.gif",
    "langsmith/demo.mp4",
    "oss/agents/architecture.svg",
    "oss/data.json",
    "oss/diagram.excalidraw",
  ]) {
    assert.equal(isMirroredMarkdownPath(relPath), false, relPath);
  }
});

test("does not false-positive on a path that merely contains 'md' or 'mdx' mid-name", () => {
  assert.equal(isMirroredMarkdownPath("oss/langgraph/mdx-components.tsx"), false);
  assert.equal(isMirroredMarkdownPath("oss/mdx/loader.ts"), false);
});
