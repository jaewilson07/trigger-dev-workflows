import { task, logger } from "@trigger.dev/sdk";
import { outputDelivered, outputFailed, outputSkipped } from "../lib/storm-types.js";
import type { StormBriefingWithMarkdown, OutputResult } from "../lib/storm-types.js";

export type OutputMdragIngestPayload = {
  briefing: StormBriefingWithMarkdown;
  topic: string;
};

const MDRAG_INGEST_URL = "https://wiki.datacrew.space/api/v1/ingest/text";
const MDRAG_COLLECTION_ID = "6a274087d4b0a3ad1b028ae8";
const MDRAG_SOURCE_GROUP = "datacrew";

/**
 * output-mdrag-ingest — pushes the Markdown report into the mdrag knowledge
 * base so future research (and the Slack bots) can retrieve it.
 *
 * Never throws: a failed ingest is reported as `success: false` so it can't
 * sink the other output destinations.
 */
export const outputMdragIngest = task({
  id: "output-mdrag-ingest",
  retry: { maxAttempts: 1 },
  run: async (payload: OutputMdragIngestPayload): Promise<OutputResult> => {
    logger.info("starting output-mdrag-ingest");
    const { briefing, topic } = payload;

    const token = process.env.DATACREW_API_TOKEN ?? "";
    if (!token) {
      const error = "DATACREW_API_TOKEN not set";
      logger.warn("output-mdrag-ingest: skipping ingest", { error });
      return outputSkipped("mdrag", error);
    }

    try {
      const res = await fetch(MDRAG_INGEST_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: briefing.markdown,
          collection_id: MDRAG_COLLECTION_ID,
          source_group: MDRAG_SOURCE_GROUP,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        throw new Error(`mdrag ingest error: ${res.status} ${await res.text()}`);
      }

      const data = (await res.json().catch(() => ({}))) as { url?: string; id?: string };
      logger.info("output-mdrag-ingest: ingested report", {
        topic,
        markdownChars: briefing.markdown.length,
        documentId: data.id,
      });

      return outputDelivered("mdrag", data.url);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn("output-mdrag-ingest: ingest failed", { error, topic });
      return outputFailed("mdrag", error);
    }
  },
});
