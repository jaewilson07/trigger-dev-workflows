import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — LangChain's OSS docs (LangChain/LangGraph/Deep Agents/
 * integrations, at docs.langchain.com) had no sync before this task.
 *
 * Mirrors `langchain-ai/docs`'s `src/oss` subtree (confirmed the docs
 * site's real source via its "Edit this page on GitHub" footer link — the
 * site itself is Mintlify, not plain markdown, so ingesting the source
 * repo directly is the reliable path, same reasoning as domo-docs) into
 * `vendor-docs-sync/langchain-oss-docs/`, then ingests that subfolder.
 * `src/langsmith` is deliberately excluded here — LangSmith is a separate
 * product with its own sync, `langsmithDocsIngest.ts`, and its own
 * collection (see `vendorDocsIngest.ts`'s registry doc comment on this
 * source — merging the two would be the same "collection collapse" mistake
 * the subpath-scoping note above already warns about).
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "langchain-oss-docs")!;

type LangchainOssDocsIngestPayload = {
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

export const langchainOssDocsIngest = schedules.task({
  id: "langchain-oss-docs-ingest",
  cron: {
    // Same daily cadence as every other vendor-docs-sync source, staggered
    // 5 minutes off the shared `0 9 * * *` slot (and 5 minutes from
    // langsmith-docs-ingest below) — all 5 git-mirror tasks clone the same
    // jaewilson07/vendor-docs-sync repo and `git push` straight to main with
    // no fetch/rebase/retry (vendorDocsMirror.ts's commitAndPushIfChanged),
    // so two pushing in the same minute non-fast-forward-fails whichever
    // lands second. Staggering only reduces the odds for THIS addition, not
    // a real fix — that gap already exists among domo-docs/letta-docs/
    // trigger-dev-skills and is filed separately (see PR description).
    pattern: "5 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Sized against domoDocsIngest.ts/lettaDocsIngest.ts's comparable
  // clone-sync-commit-push budget for a subpath of a repo.
  maxDuration: 1800,
  run: async (_payload: LangchainOssDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting langchain-oss-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed langchain-oss-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed langchain-oss-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
