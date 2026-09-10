import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — Trigger.dev's own product docs (docs.trigger.dev: tasks,
 * schedules, realtime, deployment, ...) had no sync before this task.
 * Distinct from the existing `trigger-dev-skills` source, which mirrors
 * triggerdotdev/skills (AI agent-skill definitions), not the product's
 * reference docs — see `vendorDocsIngest.ts`'s registry doc comment on this
 * source for why the two get separate collections.
 *
 * Mirrors triggerdotdev/trigger.dev's `docs` subpath into
 * `vendor-docs-sync/trigger-dev-docs/`, then ingests that subfolder.
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "trigger-dev-docs")!;

type TriggerDevDocsIngestPayload = {
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

export const triggerDevDocsIngest = schedules.task({
  id: "trigger-dev-docs-ingest",
  cron: {
    // Staggered off the shared `0 9 * * *` slot other git-mirror sources use
    // — see langchainOssDocsIngest.ts's cron comment for why any stagger
    // exists at all (all git-mirror tasks push straight to
    // jaewilson07/vendor-docs-sync main with no fetch/rebase/retry). 15 9
    // is unused by langsmith-docs-ingest (5 9) / langchain-oss-docs-ingest
    // (10 9) / the pre-existing domo/letta/trigger-dev-skills tasks.
    pattern: "15 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Sized against domoDocsIngest.ts/lettaDocsIngest.ts's comparable
  // clone-sync-commit-push budget for a subpath of a repo.
  maxDuration: 1800,
  run: async (_payload: TriggerDevDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting trigger-dev-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed trigger-dev-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed trigger-dev-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
