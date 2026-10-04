import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — Alertmanager's docs (prometheus.io/docs/alerting:
 * configuration, routing trees, receivers and integrations, notification
 * templates, high availability), from prometheus/alertmanager's `docs/`
 * subpath. Third member of the Prometheus docs set alongside
 * prometheusDocsIngest.ts and prometheusServerDocsIngest.ts.
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "alertmanager-docs")!;

type AlertmanagerDocsIngestPayload = {
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

export const alertmanagerDocsIngest = schedules.task({
  id: "alertmanager-docs-ingest",
  cron: {
    // The 9am hour's five-minute slots are all taken (0..55), so this one
    // starts a 10am row — same stagger reasoning as langchainOssDocsIngest.ts's
    // cron comment (jaewilson07/trigger-dev-workflows#154, still open).
    pattern: "0 10 * * *",
    environments: ["PRODUCTION"],
  },
  // Small corpus (~11 files); budget kept identical to its siblings.
  maxDuration: 1800,
  run: async (_payload: AlertmanagerDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting alertmanager-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed alertmanager-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed alertmanager-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
