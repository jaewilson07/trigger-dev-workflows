import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — `letta-ai/letta-code`'s own repo had no sync before this task,
 * distinct from `lettaDocsIngest.ts` which mirrors the generated docs-site
 * export (`letta-ai/letta-docs-md`). This pulls documentation that only
 * lives in the CLI's source repo itself — most notably
 * `src/channels/README.md` (the channel-plugin architecture: `plugin.mjs`
 * shape, `ChannelGateway` routing/pairing, first-party-vs-custom
 * auto-routing) — plus root README/AGENTS/CONTRIBUTING/CLAUDE/AI_POLICY.md
 * and `docs/*.md`. No `subpath`: the markdown-only filter (#154) already
 * limits the mirror to these files, not the TS source tree.
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "letta-code-source")!;

type LettaCodeSourceIngestPayload = {
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

export const lettaCodeSourceIngest = schedules.task({
  id: "letta-code-source-ingest",
  cron: {
    // Same daily cadence as every other vendor-docs-sync source, staggered
    // into the next free 5-minute slot after fastmcp-docs (30 9). See
    // langchainOssDocsIngest.ts's comment for why staggering only reduces
    // (not eliminates) the shared-repo git-push race across all git-mirror
    // tasks (jaewilson07/trigger-dev-workflows#154).
    pattern: "35 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Sized against the other whole-repo git-mirror sources (letta-docs,
  // trigger-dev-skills) — clone-sync-commit-push budget for a small repo.
  maxDuration: 1800,
  run: async (_payload: LettaCodeSourceIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting letta-code-source-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed letta-code-source-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed letta-code-source-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
