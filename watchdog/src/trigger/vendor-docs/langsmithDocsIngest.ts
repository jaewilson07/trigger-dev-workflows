import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — LangSmith's docs (a separate observability product, self-
 * hostable as a LangChain Enterprise add-on — see the KB entry this task
 * was ingested to support) had no sync before this task.
 *
 * Mirrors `langchain-ai/docs`'s `src/langsmith` subtree — the same upstream
 * repo as `langchainOssDocsIngest.ts`, but a distinct subpath and its own
 * collection, so LangSmith and LangChain-OSS docs never collapse into one
 * collection (see `vendorDocsIngest.ts`'s registry doc comment on this
 * source).
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "langsmith-docs")!;

type LangsmithDocsIngestPayload = {
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

export const langsmithDocsIngest = schedules.task({
  id: "langsmith-docs-ingest",
  cron: {
    // Prioritized ahead of langchain-oss-docs-ingest (2026-09-10) — runs
    // first, 5 minutes off the shared `0 9 * * *` slot. See that task's cron
    // comment for why any stagger exists at all: all 5 git-mirror sources
    // push straight to jaewilson07/vendor-docs-sync main with no retry, so
    // same-minute runs can non-fast-forward-fail.
    pattern: "5 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Sized against domoDocsIngest.ts/lettaDocsIngest.ts's comparable
  // clone-sync-commit-push budget for a subpath of a repo.
  maxDuration: 1800,
  run: async (_payload: LangsmithDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting langsmith-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed langsmith-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed langsmith-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
