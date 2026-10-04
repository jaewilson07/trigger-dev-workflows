import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — Grafana Loki's docs (grafana.com/docs/loki: setup,
 * configuration, LogQL, operations, sending data). Part of the Grafana OSS
 * monitoring-stack docs set — see grafanaDocsIngest.ts.
 *
 * Mirrors grafana/loki's `docs/sources` subpath (minus the per-release
 * `release-notes` pages) into `vendor-docs-sync/loki-docs/`, then ingests
 * that subfolder. See `vendorDocsIngest.ts`'s registry doc comment on this
 * source.
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "loki-docs")!;

type LokiDocsIngestPayload = {
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

export const lokiDocsIngest = schedules.task({
  id: "loki-docs-ingest",
  cron: {
    // Next unused slot off the shared `~9 9 * * *` base — see
    // langchainOssDocsIngest.ts's cron comment for why any stagger exists
    // at all (jaewilson07/trigger-dev-workflows#154, still open).
    pattern: "40 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Sized against comfyuiDocsIngest.ts's comparable budget; loki-docs'
  // filtered corpus is ~180 files / ~2.7MB.
  maxDuration: 1800,
  run: async (_payload: LokiDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting loki-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed loki-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed loki-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
