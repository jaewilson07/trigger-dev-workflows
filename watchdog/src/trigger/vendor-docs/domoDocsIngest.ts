import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { VENDOR_DOCS_GIT_MIRROR_SOURCES, withVendorDocsFailureReporting } from "../../lib/vendorDocsIngest.js";
import { runVendorDocsGitMirrorTask } from "../../lib/vendorDocsTasks.js";

/**
 * Refactored onto the shared vendor-docs-sync helpers —
 * jaewilson07/trigger-dev-workflows#128 (User Story 8: "the existing
 * domo-docs sync task refactored onto the same shared mirror-then-ingest
 * helper as the new sources, so there's exactly one implementation ... not a
 * special case for domo").
 *
 * Was: a single POST straight at `DomoApps/domo-documentation-hub` (see git
 * history for the original `watchdog/src/trigger/domoDocsIngest.ts`, and
 * jaewilson07/trigger-dev-workflows#31/#34/#36 for its own migration
 * history). Now: mirror `DomoApps/domo-documentation-hub`'s `s/article`
 * subtree into `vendor-docs-sync/domo-docs/` (commit + push only on a real
 * diff), then ingest THAT subfolder with domo-docs' existing, explicit
 * `collection_id` — never mdrag's auto-derived one, which would otherwise
 * collapse all four vendor-docs-sync sources into a single collection (see
 * `vendorDocsIngest.ts`'s top doc comment).
 *
 * The empirical auth/header findings from the original task (the
 * `INTERNAL_SECRET` string-compare finding, the `x-user-email`
 * proxy-stripping finding, the two distinct owner-identity values in play)
 * are preserved verbatim in `vendorDocsIngest.ts`'s own doc comment — this
 * file no longer repeats them (User Story 16: "that hard-won context isn't
 * lost just because the code moved").
 */

const SOURCE = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "domo-docs")!;

type DomoDocsIngestPayload = {
  // `schedules.task` payloads carry a real `Date` when the scheduler invokes
  // them and a JSON string when a human triggers them from the dashboard/API.
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

export const domoDocsIngest = schedules.task({
  id: "domo-docs-ingest",
  cron: {
    // Matches the bonker cron entry (`domo-docs-ingest-daily`) this replaces.
    pattern: "0 9 * * *",
    environments: ["PRODUCTION"],
  },
  // Now clones + diffs + commits + pushes vendor-docs-sync (not just one
  // POST) — sized against crewRagDomoScrape.ts's comparable
  // clone-sync-commit-push budget rather than domoDocsIngest.ts's old 300s.
  maxDuration: 1800,
  run: async (_payload: DomoDocsIngestPayload, { ctx }) => {
    await safeAddTags(SOURCE.tags);

    const [ghPat, dcToken] = await Promise.all([
      // Root of the Infisical tree, not /datacrew — matches
      // crewRagDomoScrape.ts and domoDocsReport.ts's own use of this same
      // key for pushing to a jaewilson07-owned repo. Confirmed live it can
      // push to the brand-new vendor-docs-sync repo (GET
      // /repos/jaewilson07/vendor-docs-sync with this token returned
      // permissions.push: true on 2026-09-02) — no dedicated fine-grained
      // PAT was needed.
      getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
      getSecret("DATACREW_API_TOKEN"),
    ]);

    try {
      return await withVendorDocsFailureReporting(SOURCE.id, ghPat, ctx.run.id, async () => {
        logger.info("starting domo-docs-ingest", {
          subfolder: SOURCE.subfolder,
          collectionId: SOURCE.collectionId,
        });
        const result = await runVendorDocsGitMirrorTask(SOURCE, { ghPat, dcToken });
        logger.info("completed domo-docs-ingest", {
          mirrorChanged: result.mirror.changed,
          commitSha: result.mirror.commitSha,
          jobId: result.ingest.jobId,
          statusUrl: result.ingest.statusUrl,
          cleanup: result.cleanup,
        });
        return result;
      });
    } catch (error) {
      logger.error("failed domo-docs-ingest", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
