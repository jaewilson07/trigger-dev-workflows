import { schedules, logger } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { MDRAG_API_URL, ensureCollectionId } from "../lib/vendorDocsIngest.js";
import {
  LIVEKIT_COLLECTION_NAME,
  captureLivekitDocs,
} from "../lib/livekitDocsCaptureCore.js";
import type { CaptureResult, DocHashes } from "../lib/livekitDocsCaptureCore.js";
import { previousRunOutput } from "./tasks/previous-run-output.js";

/**
 * Crawls docs.livekit.io's per-section llms.txt indexes into the mdrag
 * `livekit-docs` collection (trigger-dev-workflows#272). Daily, off-peak, and
 * SHA-cached: the per-page hashes ride in the previous run's output, so an
 * unchanged page costs one GET and no ingest. Crawl/diff logic is in
 * `../lib/livekitDocsCaptureCore.ts`.
 */
const SELF_ID = "livekit-docs-capture";

type Output = Pick<CaptureResult, "hashes"> & { ingested: number; unchanged: number; failed: number };

export const livekitDocsCapture = schedules.task({
  id: SELF_ID,
  cron: { pattern: "30 4 * * *", environments: ["PRODUCTION"] },
  maxDuration: 3600,
  run: async (): Promise<Output> => {
    logger.info("starting livekit-docs-capture");
    const dcToken = await getSecret("DATACREW_API_TOKEN");
    const collectionId = await ensureCollectionId(LIVEKIT_COLLECTION_NAME, dcToken);
    const previous: DocHashes = (await previousRunOutput<Partial<Output>>(SELF_ID))?.hashes ?? {};

    const result = await captureLivekitDocs(previous, {
      fetcher: (url) => fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "datacrew-livekit-docs-capture/1.0" } }),
      ingest: async ({ url, title, content, sha }) => {
        const res = await fetch(`${MDRAG_API_URL}/api/v1/ingest/text`, {
          method: "POST",
          headers: { Authorization: `Bearer ${dcToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            title,
            source_url: url,
            collection_id: collectionId,
            metadata: { source: "docs.livekit.io", sha256: sha },
            async_mode: true,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`mdrag ingest/text returned ${res.status}: ${(await res.text()).slice(-200)}`);
      },
    });

    for (const f of result.failed) logger.warn("livekit-docs-capture: page failed", f);
    logger.info("completed livekit-docs-capture", {
      ingested: result.ingested.length,
      unchanged: result.unchanged,
      failed: result.failed.length,
    });
    if (result.failed.length > 0 && result.ingested.length + result.unchanged === 0) {
      throw new Error(`livekit-docs-capture: every page failed (first: ${result.failed[0]!.error})`);
    }
    return { hashes: result.hashes, ingested: result.ingested.length, unchanged: result.unchanged, failed: result.failed.length };
  },
});
