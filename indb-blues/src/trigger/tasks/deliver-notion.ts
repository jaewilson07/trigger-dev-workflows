import { task, logger } from "@trigger.dev/sdk";
import { upsertNotionPage, notionTokenFromEnv } from "@datacrew/trigger-shared";
import { bluesDropSkipped } from "../../lib/blues-drop-types.js";
import type { BluesDropDeliveryOutcome } from "../../lib/blues-drop-types.js";

/**
 * Notion delivery for the Blues Drop of the Week — the SECOND destination
 * (trigger-dev-workflows#99; `deliver-discord`, #98, was the first).
 *
 * Takes TITLE AND RENDERED MARKDOWN, not `BluesDropResearch` — the same
 * narrower contract `docs/notion-delivery.md` §2 documents for every other
 * `deliver-notion`/`output-notion`/`infra-deliver-notion` in this repo: a
 * Notion destination only ever wants "a page in this database, titled X,
 * containing Y", and `blues-drop-deliver` already renders that once (via
 * `lib/blues-drop-markdown.ts`) before fanning out, so this task stays
 * generic instead of importing the seam type.
 *
 * ONE ROW PER WEEK, BY CONSTRUCTION. The title
 * (`"Blues Music Drops — <date> — <topic>"`, built by the caller from the
 * RESEARCHED date, never `today`) is the upsert key — `upsertNotionPage`'s
 * `mode: "replace"` (the default) clears a matching row's blocks before
 * rewriting, so re-delivering an already-synced week updates that week's
 * row in place instead of duplicating it.
 *
 * UNCONFIGURED IS `skipped`, NOT AN ERROR — same convention as
 * `deliver-discord`'s Discord-token fallback and every other destination in
 * this repo (`docs/notion-delivery.md` §5): a checkout with no
 * `NOTION_TOKEN`/`NOTION_API_KEY` or no `NOTION_DATABASE_ID` is a normal
 * state, not a failure to report. A third unconfigured state fails
 * differently and is not detectable here: an integration that exists but
 * was never shared with the target database surfaces as `object_not_found`
 * from the Notion API and lands as `failed` with the code in the message
 * (`upsertNotionPage`'s own error, via `notionFetch`) — the fix is
 * Notion-side (share the integration with the database), not a code change.
 */
export type DeliverNotionPayload = {
  /** Carried through so a `skipped`/`failed` report still names its week,
   * matching every other `BluesDropDeliveryOutcome` variant. */
  weekId: string;
  /** The page title, and the upsert key — see this module's docstring. */
  title: string;
  /** The page body. Converted to Notion blocks by `@datacrew/trigger-shared`'s `notion.ts`. */
  markdown: string;
  /** Defaults to NOTION_DATABASE_ID. Accepts a raw id, a dashed id, or a pasted URL. */
  databaseId?: string;
  /** Defaults to NOTION_TOKEN, then NOTION_API_KEY. */
  token?: string;
  /** `replace` (default) rewrites an existing row's content; `append` adds to it. */
  mode?: "replace" | "append";
  /** Extra database properties (e.g. Week/Topic/Date), merged with the title.
   * Types must match the "Blues Music Drops" database's schema. */
  properties?: Record<string, unknown>;
  /** `false` returns `skipped` without publishing. */
  enabled?: boolean;
};

export const deliverNotion = task({
  id: "deliver-notion",
  // Covers a transient Notion 5xx or a rate-limit 429. Safe to retry in
  // either mode: `replace` clears before writing so a half-written page is
  // rewritten whole, and the title-keyed upsert cannot create a duplicate row.
  retry: { maxAttempts: 2 },
  run: async (payload: DeliverNotionPayload): Promise<BluesDropDeliveryOutcome> => {
    logger.info("starting deliver-notion", { weekId: payload.weekId });

    if (payload.enabled === false) {
      return bluesDropSkipped("notion", payload.weekId, "disabled by caller");
    }

    const token = payload.token ?? notionTokenFromEnv();
    if (!token) {
      return bluesDropSkipped(
        "notion",
        payload.weekId,
        "neither NOTION_TOKEN nor NOTION_API_KEY set, and no token in payload"
      );
    }

    const databaseId = payload.databaseId ?? process.env.NOTION_DATABASE_ID ?? "";
    if (!databaseId) {
      return bluesDropSkipped(
        "notion",
        payload.weekId,
        "NOTION_DATABASE_ID not set and no databaseId in payload"
      );
    }

    const title = payload.title?.trim();
    if (!title) {
      // Not `skipped`: an empty title is a caller bug, not a configuration
      // state, and Notion would happily create an untitled row nothing can
      // ever find again by title.
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

    logger.info("deliver-notion: published", {
      weekId: payload.weekId,
      title,
      pageId: result.pageId,
      created: result.created,
      blockCount: result.blockCount,
    });
    logger.info("completed deliver-notion", { pageId: result.pageId, created: result.created });

    return {
      destination: "notion",
      status: "delivered",
      weekId: payload.weekId,
      url: result.url,
      pageId: result.pageId,
      created: result.created,
      title,
    };
  },
});
