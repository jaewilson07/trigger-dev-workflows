import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * Replaces the bonker cron script
 * `infra-bonker/.agents/runbooks/ingest-letta-docs/ingest-letta-docs.sh`
 * (`0 9 * * *`) — jaewilson07/trigger-dev-workflows#128. That script
 * (`docker exec mdrag-local printenv INTERNAL_SECRET` + a direct POST at
 * `letta-ai/letta-docs-md`) had no Trigger.dev equivalent, no failure
 * alerting beyond a local log file, and a documented history of silently
 * breaking for days at a time before anyone noticed (Problem Statement).
 *
 * Mirrors `letta-ai/letta-docs-md` (whole repo — matching the bonker
 * script's scope) into `vendor-docs-sync/letta-docs/`, then ingests that
 * subfolder with letta-docs' existing, explicit `collection_id`. See
 * `vendorDocsIngest.ts`'s top doc comment for the auth/collection-scoping
 * decisions this and every other vendor-docs-sync task share.
 *
 * The bonker crontab entry + script are retired only AFTER this task is
 * verified running successfully in production (Implementation Decisions,
 * "Bonker retirement") — deliberately NOT done in this change.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "letta-docs")!;

type LettaDocsIngestPayload = {
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

export const lettaDocsIngest = schedules.task({
  id: "letta-docs-ingest",
  cron: {
    // Matches the bonker cron entry this replaces.
    pattern: "0 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Sized against crewRagDomoScrape.ts's comparable clone-sync-commit-push
  // budget (clone + diff + commit + push, whole-repo scope).
  maxDuration: 1800,
  run: async (_payload: LettaDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting letta-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionId: SOURCE.collectionId,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed letta-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed letta-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
