import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — ComfyUI's official docs (docs.comfy.org: node reference,
 * custom-node authoring, workflow/interface concepts, troubleshooting) had
 * no sync before this task. Requested after a round of research into why
 * ComfyUI workflow/node configuration keeps producing hard-won-the-hard-way
 * lessons (comfy-mcp's own memory: node-registered-but-not-runnable, the
 * workflow-JSON-envelope trap, GGUF/INT8-vs-FP8 quirks) rather than answers
 * `query_rag` could have surfaced directly — this source is meant to close
 * that gap for future configuration work, not just past incidents.
 *
 * Mirrors the whole `Comfy-Org/docs` repo (root IS the docs content, no
 * `docs/` subpath) into `vendor-docs-sync/comfyui-docs/`, with locale
 * duplicates, Comfy Cloud's separate hosted product, and repo tooling
 * excluded via `excludeSubpaths` — see `vendorDocsIngest.ts`'s registry
 * doc comment on this source for the full breakdown.
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "comfyui-docs")!;

type ComfyuiDocsIngestPayload = {
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

export const comfyuiDocsIngest = schedules.task({
  id: "comfyui-docs-ingest",
  cron: {
    // Next unused slot off the shared `~9 9 * * *` base — see
    // langchainOssDocsIngest.ts's cron comment for why any stagger exists
    // at all (jaewilson07/trigger-dev-workflows#154, still open).
    pattern: "30 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Sized against domoDocsIngest.ts/lettaDocsIngest.ts's comparable
  // clone-sync-commit-push budget for a subpath of a repo. comfyui-docs'
  // filtered corpus (~1825 files/7.7MB) is comparable in scale to
  // langchain-oss-docs, well inside this budget.
  maxDuration: 1800,
  run: async (_payload: ComfyuiDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting comfyui-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed comfyui-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed comfyui-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
