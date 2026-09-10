import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — Langfuse's product docs (docs.langfuse.com: tracing,
 * evaluation, prompt management, self-hosting, ...) had no sync before this
 * task. Filled a real gap: ADR-049 names self-hosted Langfuse as the
 * intended future agentic-tracing layer, but before this task the KB had no
 * real Langfuse documentation — only this repo's own ADRs mentioning it by
 * name, which `query_rag` conflated with LangSmith docs on a bare "Langfuse"
 * query (jaewilson07/trigger-dev-workflows#161).
 *
 * Mirrors langfuse/langfuse-docs' `content/docs` subpath (the technical
 * reference; that repo's `content/` also holds blog/changelog/marketing,
 * deliberately excluded — see `vendorDocsIngest.ts`'s registry doc comment
 * on this source) into `vendor-docs-sync/langfuse-docs/`, then ingests that
 * subfolder.
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "langfuse-docs")!;

type LangfuseDocsIngestPayload = {
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

export const langfuseDocsIngest = schedules.task({
  id: "langfuse-docs-ingest",
  cron: {
    // Next unused slot off the shared `~9 9 * * *` base — see
    // langchainOssDocsIngest.ts's cron comment for why any stagger exists
    // at all (jaewilson07/trigger-dev-workflows#154, still open).
    pattern: "20 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Sized against domoDocsIngest.ts/lettaDocsIngest.ts's comparable
  // clone-sync-commit-push budget for a subpath of a repo.
  maxDuration: 1800,
  run: async (_payload: LangfuseDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting langfuse-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed langfuse-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed langfuse-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
