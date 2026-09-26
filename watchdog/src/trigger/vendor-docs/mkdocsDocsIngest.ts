import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * New sync — MkDocs' core docs (getting started, user guide: configuration, writing your docs, themes, plugins; dev guide), from mkdocs/mkdocs' `docs/` subpath. First member of the MkDocs docs set alongside mkdocsMaterialDocsIngest.ts, mkdocstringsDocsIngest.ts, mkdocstringsPythonDocsIngest.ts and griffeDocsIngest.ts — the toolchain crew-dcs' generated API documentation is built on.
 *
 * No prior ingest exists for this source (no `collectionId` in the
 * registry), so `runVendorDocsGitMirrorTask` resolves-or-creates the
 * collection by name and skips the cutover-cleanup step — see that
 * function's doc comment.
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "mkdocs-docs")!;

type MkdocsDocsIngestPayload = {
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

export const mkdocsDocsIngest = schedules.task({
  id: "mkdocs-docs-ingest",
  cron: {
    // Continues the 10am row after alertmanagerDocsIngest.ts's 0 10 slot (the
    // 9am hour's slots are all taken) — same stagger reasoning as
    // langchainOssDocsIngest.ts's cron comment
    // (jaewilson07/trigger-dev-workflows#154, still open).
    pattern: "5 10 * * *",
    environments: ["PRODUCTION"],
  },
  // Small markdown-only corpus; budget kept identical to its siblings.
  maxDuration: 1800,
  run: async (_payload: MkdocsDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting mkdocs-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionName: SOURCE.collectionName,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed mkdocs-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed mkdocs-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
