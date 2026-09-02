import { promises as fs } from "node:fs";
import path from "node:path";
import { cloneVendorDocsSync, runCrawlMirror, runGitMirror } from "./vendorDocsMirror.js";
import type { CrawlMirrorOutcome, MirrorCommitResult } from "./vendorDocsMirror.js";
import {
  cleanupStaleDocuments,
  createMdragStaleDocumentsClient,
  ensureCollectionId,
  ingestVendorDocsSubfolder,
  isStaleCleanupLive,
} from "./vendorDocsIngest.js";
import type {
  CleanupOutcome,
  IngestOutcome,
  VendorDocsCrawlMirrorSourceConfig,
  VendorDocsGitMirrorSourceConfig,
} from "./vendorDocsIngest.js";

/**
 * Per-task orchestration — mirror -> ingest -> (cutover cleanup) —
 * jaewilson07/trigger-dev-workflows#128.
 *
 * Split out from `vendorDocsIngest.ts` on purpose: this is the only place
 * that needs BOTH the I/O mirror shell (`vendorDocsMirror.ts`, which depends
 * on `@datacrew/trigger-shared`) and the ingest/cleanup/GitHub-issue logic
 * (`vendorDocsIngest.ts`, which doesn't). Keeping them combined only here
 * means `vendorDocsIngest.ts` stays free of the `@datacrew/trigger-shared`
 * dependency and so stays runnable by this repo's plain `node --test`
 * harness — see `vendorDocsMirrorCore.ts`'s doc comment for why that
 * dependency can't be loaded there. Not unit tested directly (I/O
 * end-to-end); its two callees are tested individually.
 */

export type GitMirrorTaskOutcome = {
  mirror: MirrorCommitResult;
  ingest: IngestOutcome;
  cleanup: CleanupOutcome;
};

/**
 * Full run for one git-mirror source (domo-docs, letta-docs,
 * trigger-dev-skills): clone vendor-docs-sync, mirror the upstream repo into
 * its subfolder, ingest that subfolder (always — mdrag's own
 * upsert-on-source_url absorbs a same-content re-ingest, see
 * `vendorDocsIngest.ts`'s top doc comment, "Idempotency, two layers"), then
 * run the cutover cleanup (dry-run unless `VENDOR_DOCS_STALE_CLEANUP_LIVE=true`).
 */
export async function runVendorDocsGitMirrorTask(
  source: VendorDocsGitMirrorSourceConfig,
  opts: { ghPat: string; dcToken: string }
): Promise<GitMirrorTaskOutcome> {
  const vendorDocsSyncDir = await cloneVendorDocsSync(opts.ghPat);
  try {
    const mirror = await runGitMirror(
      { id: source.id, subfolder: source.subfolder, upstream: source.upstream },
      vendorDocsSyncDir,
      opts.ghPat
    );
    const ingest = await ingestVendorDocsSubfolder(
      { subfolder: source.subfolder },
      source.collectionId,
      opts.dcToken
    );
    const cleanupClient = createMdragStaleDocumentsClient(opts.dcToken);
    const cleanup = await cleanupStaleDocuments(source.collectionId, source.oldSourceUrlPrefix, cleanupClient, {
      dryRun: !isStaleCleanupLive(),
    });
    return { mirror, ingest, cleanup };
  } finally {
    await fs.rm(path.dirname(vendorDocsSyncDir), { recursive: true, force: true });
  }
}

export type CrawlMirrorTaskOutcome = {
  mirror: CrawlMirrorOutcome;
  ingest: IngestOutcome;
};

/** Full run for claude-code-docs: clone vendor-docs-sync, crawl-mirror the docs site, ensure its collection, ingest. No cutover cleanup — no prior ingest existed for this source. */
export async function runVendorDocsCrawlMirrorTask(
  source: VendorDocsCrawlMirrorSourceConfig,
  opts: { ghPat: string; dcToken: string }
): Promise<CrawlMirrorTaskOutcome> {
  const vendorDocsSyncDir = await cloneVendorDocsSync(opts.ghPat);
  try {
    const mirror = await runCrawlMirror(vendorDocsSyncDir, opts.ghPat);
    const collectionId = await ensureCollectionId(source.collectionName, opts.dcToken);
    const ingest = await ingestVendorDocsSubfolder(
      { subfolder: source.subfolder },
      collectionId,
      opts.dcToken
    );
    return { mirror, ingest };
  } finally {
    await fs.rm(path.dirname(vendorDocsSyncDir), { recursive: true, force: true });
  }
}
