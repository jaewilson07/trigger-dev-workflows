import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import {
  VENDOR_DOCS_CLAUDE_CODE_DOCS_SOURCE,
  withVendorDocsFailureReporting,
} from "../../lib/vendorDocsIngest.js";
import { runVendorDocsCrawlMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — Claude / Claude Code documentation had no sync at all before
 * jaewilson07/trigger-dev-workflows#128 (Problem Statement: "no upstream git
 * repo of docs to point mdrag at directly in the first place").
 *
 * Unlike the other three sources, this one is crawl-mirror, not git-mirror:
 * pages are discovered via Anthropic's own sitemap (candidate URLs tried in
 * `vendorDocsMirror.ts`'s `discoverSitemap`), fetched as markdown with
 * retry/429-backoff, and validated before being written into
 * `vendor-docs-sync/claude-code-docs/` alongside a `manifest.json` (source
 * URL + hash per doc). Ported conceptually from
 * `ericbuess/claude-code-docs`'s `scripts/fetch_claude_docs.py` — cited as a
 * design reference only, this task does not depend on that repo staying
 * maintained (User Story 10).
 *
 * No prior ingest existed for this source, so:
 *   - there is no existing `collection_id` to pass — `ensureCollectionId`
 *     resolves-or-creates `repo_claude-code-docs` by name at runtime, on
 *     this task's first real production run (never invoked by this build —
 *     see `vendorDocsIngest.ts`'s registry doc comment).
 *   - there is no stale-document cleanup step (Implementation Decisions:
 *     "claude-code-docs has no prior ingest, so no cleanup needed there").
 */

type ClaudeCodeDocsIngestPayload = {
  timestamp: Date | string;
  timezone: string;
};

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    console.warn(
      "Skipping Trigger.dev tags outside managed runtime:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export const claudeCodeDocsIngest = schedules.task({
  id: "claude-code-docs-ingest",
  cron: {
    // Matches the other three vendor-docs-sync sources' cadence.
    pattern: "0 9 * * *",
    environments: ["PRODUCTION"],
  },
  // The crawl-mirror strategy fetches many individual pages (one HTTP
  // round-trip + retry/backoff per discovered doc, plus a rate-limit delay
  // between each) rather than one clone — more headroom than the git-mirror
  // sources' 1800s budget is not needed, but more than domoDocsIngest.ts's
  // old 300s clearly is; sized per the issue's explicit number.
  maxDuration: 900,
  run: async (_payload: ClaudeCodeDocsIngestPayload, { ctx }) => {
    await safeAddTags(VENDOR_DOCS_CLAUDE_CODE_DOCS_SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(
        VENDOR_DOCS_CLAUDE_CODE_DOCS_SOURCE.id,
        ghPat,
        ctx.run.id,
        async () => {
          logger.info("starting claude-code-docs-ingest", {
            subfolder: VENDOR_DOCS_CLAUDE_CODE_DOCS_SOURCE.subfolder,
          });
          const result = await runVendorDocsCrawlMirrorTask(VENDOR_DOCS_CLAUDE_CODE_DOCS_SOURCE, {
            ghPat,
            dcToken,
          });
          logger.info("completed claude-code-docs-ingest", {
            mirrorChanged: result.mirror.changed,
            commitSha: result.mirror.commitSha,
            pagesDiscovered: result.mirror.pagesDiscovered,
            pagesFetched: result.mirror.pagesFetched,
            pagesFailed: result.mirror.pagesFailed,
            jobId: result.ingest.jobId,
            statusUrl: result.ingest.statusUrl,
          });
          return result;
        }
      );
    } catch (error) {
      logger.error("failed claude-code-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
