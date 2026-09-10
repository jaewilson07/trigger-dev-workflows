import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — FastMCP's product docs (gofastmcp.com) had no sync before this
 * task. Pinned to the current v4 docs specifically: `PrefectHQ/fastmcp`'s
 * `docs` subpath also carries a full `docs/v2/` legacy tree kept in-tree for
 * existing v2 users, excluded via `excludeSubpaths` so a v2-era answer can't
 * surface uncited for a v4 question — see `vendorDocsIngest.ts`'s registry
 * doc comment on this source.
 *
 * Mirrors that filtered subtree into `vendor-docs-sync/fastmcp-docs-v4/`,
 * then ingests that subfolder.
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "fastmcp-docs")!;

type FastmcpDocsIngestPayload = {
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

export const fastmcpDocsIngest = schedules.task({
  id: "fastmcp-docs-ingest",
  cron: {
    // Next unused slot off the shared `~9 9 * * *` base — see
    // langchainOssDocsIngest.ts's cron comment for why any stagger exists
    // at all (jaewilson07/trigger-dev-workflows#154, still open).
    pattern: "25 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Sized against domoDocsIngest.ts/lettaDocsIngest.ts's comparable
  // clone-sync-commit-push budget for a subpath of a repo.
  maxDuration: 1800,
  run: async (_payload: FastmcpDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting fastmcp-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed fastmcp-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed fastmcp-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
