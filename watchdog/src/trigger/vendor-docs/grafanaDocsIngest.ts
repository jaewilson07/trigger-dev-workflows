import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — Grafana OSS's product docs (grafana.com/docs/grafana: data
 * sources, dashboards/visualizations, alerting, provisioning/as-code,
 * administration, setup). Added alongside loki-docs, alloy-docs,
 * prometheus-docs and prometheus-server-docs when the house adopted the
 * self-hosted Grafana OSS monitoring stack, so `query_rag` can answer
 * configuration questions from the real docs rather than recall.
 *
 * Mirrors grafana/grafana's `docs/sources` subpath (minus the per-release
 * `whatsnew` pages) into `vendor-docs-sync/grafana-docs/`, then ingests that
 * subfolder. See `vendorDocsIngest.ts`'s registry doc comment on this source
 * for the scoping and the default-branch (`next`, not `latest`) caveat.
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "grafana-docs")!;

type GrafanaDocsIngestPayload = {
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

export const grafanaDocsIngest = schedules.task({
  id: "grafana-docs-ingest",
  cron: {
    // Next unused slot off the shared `~9 9 * * *` base — see
    // langchainOssDocsIngest.ts's cron comment for why any stagger exists
    // at all (jaewilson07/trigger-dev-workflows#154, still open).
    pattern: "35 9 * * *",
    environments: ["PRODUCTION"],
  },
  // grafana/grafana is a large monorepo; the shallow (`--depth 1`) clone
  // is the dominant cost, but the markdown-only filter keeps the mirrored
  // corpus to ~730 files / ~7MB, about comfyui-docs' byte size.
  maxDuration: 1800,
  run: async (_payload: GrafanaDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting grafana-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed grafana-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed grafana-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
