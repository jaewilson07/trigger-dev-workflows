import { task, logger } from "@trigger.dev/sdk";
import { upsertNotionPage, notionSkipped, notionTokenFromEnv } from "../lib/notion.js";
import type { NotionDeliveryOutcome } from "../lib/notion.js";

/**
 * Notion delivery — one database row per delivered document.
 *
 * ## Why ONE task serves both seams
 *
 * Every other destination in this project comes in pairs, because the two
 * seams genuinely need different behaviour: `deliver-gdoc` defaults to
 * overwriting one rolling doc (right for a daily cron, wrong for research runs
 * where each run is its own document) while `report-gdoc` inverts that default
 * and creates a dated doc. `deliver-slack` renders Block Kit from
 * `BriefResearch.triageResults`; `report-slack` renders it from
 * `ResearchReport.steps`. Neither could be written against the other's payload.
 *
 * Notion has no such split. Both seams want the same thing — "a page in this
 * database, titled X, containing Y" — and Notion's own upsert key IS the title,
 * so the cron's "keep one rolling entry" and the research run's "one row per
 * run" fall out of the titles the callers already build (`Morning Brief —
 * 2026-08-05` repeats per day; `Pattern Hunter — trailer rental (2026-08-05)`
 * does not). Splitting this into `deliver-notion` and `report-notion` would
 * have produced two identical files differing in an import.
 *
 * So this task takes TITLE AND MARKDOWN rather than a seam type. That is a
 * narrower contract than its siblings and deliberately so: it is the one
 * destination that needs nothing structural, and typing it to either seam
 * would have locked out the other.
 *
 * ## Unconfigured is `skipped`
 *
 * The token (`NOTION_TOKEN`, or `NOTION_API_KEY` — see `notionTokenFromEnv`)
 * or `NOTION_DATABASE_ID` missing returns `skipped`, not an
 * error — the same convention as every other destination here
 * (`lib/brief-delivery.ts` documents the reasoning). A fresh checkout with no
 * Notion integration is a normal state, and reporting it as a failure trains
 * everyone to ignore the failure count.
 *
 * There is a third unconfigured state worth naming, because it fails
 * differently: a Notion integration that exists but has never been SHARED with
 * the target database. That is not detectable from the environment, so it
 * surfaces as an `object_not_found` from the API and lands as `failed` with
 * the code in the message (`lib/notion.ts`'s `notionFetch`). "Add the
 * integration as a connection on the database" is the fix.
 */
export type DeliverNotionPayload = {
  /** The page title, and the upsert key — see this module's docstring. */
  title: string;
  /** The page body. Converted to Notion blocks by `lib/notion.ts`. */
  markdown: string;
  /** Defaults to NOTION_DATABASE_ID. Accepts a raw id, a dashed id, or a pasted URL. */
  databaseId?: string;
  /** Defaults to NOTION_TOKEN, then NOTION_API_KEY. */
  token?: string;
  /**
   * `replace` (default) rewrites an existing row's content; `append` adds to
   * it. Replace is right for a re-delivery, which should not double the body.
   */
  mode?: "replace" | "append";
  /**
   * Extra database properties, merged with the title. Types must match the
   * database schema — a mismatch is a 400, so this is opt-in rather than
   * something the orchestrators populate by guessing at column names.
   */
  properties?: Record<string, unknown>;
  /** `false` returns `skipped` without publishing. */
  enabled?: boolean;
};

export const deliverNotion = task({
  id: "deliver-notion",
  // Covers a transient Notion 5xx or a rate-limit 429. Safe to retry in either
  // mode: `replace` clears before writing so a half-written page is rewritten
  // whole, and the title-keyed upsert cannot create a duplicate row.
  retry: { maxAttempts: 2 },
  run: async (payload: DeliverNotionPayload): Promise<NotionDeliveryOutcome> => {
    if (payload.enabled === false) {
      return notionSkipped("disabled by caller");
    }

    const token = payload.token ?? notionTokenFromEnv();
    if (!token) {
      return notionSkipped("neither NOTION_TOKEN nor NOTION_API_KEY set, and no token in payload");
    }

    const databaseId = payload.databaseId ?? process.env.NOTION_DATABASE_ID ?? "";
    if (!databaseId) {
      return notionSkipped("NOTION_DATABASE_ID not set and no databaseId in payload");
    }

    const title = payload.title?.trim();
    if (!title) {
      // Not `skipped`: an empty title is a caller bug, not a configuration
      // state, and Notion would happily create an untitled row that nothing
      // can ever find again by title.
      throw new Error("deliver-notion: title is required");
    }

    const result = await upsertNotionPage({
      token,
      databaseId,
      title,
      markdown: payload.markdown ?? "",
      ...(payload.mode ? { mode: payload.mode } : {}),
      ...(payload.properties ? { properties: payload.properties } : {}),
    });

    logger.info("Published to Notion", {
      title,
      pageId: result.pageId,
      created: result.created,
      blockCount: result.blockCount,
    });

    return {
      destination: "notion",
      status: "delivered",
      url: result.url,
      pageId: result.pageId,
      created: result.created,
    };
  },
});
