import { task, logger } from "@trigger.dev/sdk";
import { upsertNotionPage, notionTokenFromEnv } from "../lib/notion.js";
import { outputDelivered, outputSkipped } from "../lib/storm-types.js";
import type { OutputResult, StormBriefingWithMarkdown } from "../lib/storm-types.js";

/**
 * Notion delivery for a STORM briefing — the FIFTH destination.
 *
 * A STORM report is the longest-lived artifact this repo produces: hours of
 * interviews, verification and revision, ending in a cited document somebody
 * will want to find again in three months. Slack scrolls away and the Google
 * Doc lives in one person's Drive; a Notion database row is the shape that is
 * searchable and linkable by a team, next to whatever else they keep there.
 *
 * TITLE AS UPSERT KEY. `STORM Research: <topic>` matches the Google Doc
 * destination's title exactly (`tasks/output-google-doc.ts`), so the same topic
 * researched twice REWRITES its row rather than accumulating near-duplicates —
 * which is what you want from a research wiki and is the same call
 * `output-mdrag-ingest` makes. A caller who wants a dated history per run
 * passes an explicit `title`.
 *
 * MARKDOWN, NOT HTML. `StormBriefingWithMarkdown` carries html, markdown and a
 * plain summary; Notion's block model is structural, so the markdown is what
 * converts losslessly (`lib/notion.ts`). The html exists for the Google Doc
 * path and is deliberately ignored here.
 *
 * Never throws for a configuration reason: an unconfigured Notion integration
 * returns `skipped`, the same as every other destination in this project.
 */
export type OutputNotionPayload = {
  briefing: StormBriefingWithMarkdown;
  /** Defaults to `STORM Research: <topic>`. Doubles as the upsert key. */
  title?: string;
  /** Defaults to NOTION_DATABASE_ID. Accepts a raw id, a dashed id, or a pasted URL. */
  databaseId?: string;
  /** Defaults to NOTION_TOKEN, then NOTION_API_KEY. */
  token?: string;
  /** `replace` (default) rewrites an existing row; `append` adds to it. */
  mode?: "replace" | "append";
  /** `false` returns `skipped` — how `storm-deliver` says "not requested". */
  enabled?: boolean;
};

export const outputNotion = task({
  id: "output-notion",
  // Covers a transient Notion 5xx or a 429. Safe: the title-keyed upsert cannot
  // create a duplicate row, and `replace` clears before writing.
  retry: { maxAttempts: 2 },
  run: async (payload: OutputNotionPayload): Promise<OutputResult> => {
    if (payload.enabled === false) {
      return outputSkipped("notion", "not requested");
    }

    const token = payload.token ?? notionTokenFromEnv();
    if (!token) {
      return outputSkipped("notion", "neither NOTION_TOKEN nor NOTION_API_KEY set");
    }

    const databaseId = payload.databaseId ?? process.env.NOTION_DATABASE_ID ?? "";
    if (!databaseId) {
      return outputSkipped("notion", "NOTION_DATABASE_ID not set");
    }

    const { briefing } = payload;
    const title = payload.title ?? `STORM Research: ${briefing.topic}`;

    // Every other destination in this project catches its own errors and
    // returns `failed` rather than throwing, so one bad destination cannot
    // surface as a dead run in a fan-out. Same here.
    try {
      const result = await upsertNotionPage({
        token,
        databaseId,
        title,
        markdown: briefing.markdown,
        ...(payload.mode ? { mode: payload.mode } : {}),
      });

      logger.info("output-notion: published briefing", {
        topic: briefing.topic,
        pageId: result.pageId,
        created: result.created,
        blockCount: result.blockCount,
      });

      return outputDelivered("notion", result.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("output-notion: publish failed", { topic: briefing.topic, error: message });
      return { destination: "notion", status: "failed", success: false, error: message };
    }
  },
});
