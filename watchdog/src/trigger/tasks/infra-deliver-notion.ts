import { task, logger } from "@trigger.dev/sdk";
import { upsertNotionPage, notionTokenFromEnv } from "@datacrew/trigger-shared";
import { buildMarkdown } from "../../lib/infra-health.js";
import { infraSkipped } from "../../lib/infra-delivery.js";
import type { InfraHealthReport } from "../../lib/infra-health.js";
import type { InfraDeliveryOutcome } from "../../lib/infra-delivery.js";

/**
 * Notion delivery for the infra health report — the THIRD destination.
 *
 * The three destinations answer three different questions, which is why all
 * three exist rather than one being the "real" one:
 *   - Slack: "is something broken right now" — a notification that scrolls away.
 *   - Google Doc: "what did today's report say" — one bookmarkable document.
 *   - Notion: "when did caddy first go out of date" — a queryable ROW per day,
 *     which is the shape a Doc cannot give you. `buildMarkdown`'s tables
 *     survive the conversion as real Notion tables (`lib/notion.ts`).
 *
 * ONE ROW PER DAY, BY DEFAULT. The title is `Infra health — <date>`, and
 * Notion's upsert key is the title, so a re-run on the same day rewrites that
 * day's row rather than adding a second one — the same idempotence
 * `WATCHDOG_GDOC_DOCUMENT_ID` gives the Doc destination, but without needing an
 * id to be configured first. `report.date` is the report's own date, not
 * today's, so a re-delivery of an older report files itself correctly.
 *
 * WHY A WATCHDOG WANTS A THIRD DESTINATION. The failure mode this whole
 * workflow exists to catch is "the thing that tells you something is broken is
 * the thing that broke." Slack and Drive share nothing with Notion — different
 * vendor, different token, different network path — so a Notion row is
 * evidence that survives an outage in either of the other two.
 */
export type InfraDeliverNotionPayload = {
  report: InfraHealthReport;
  /** Defaults to `Infra health — <report date>`. Doubles as the upsert key. */
  title?: string;
  /** Defaults to NOTION_DATABASE_ID. Accepts a raw id, a dashed id, or a pasted URL. */
  databaseId?: string;
  /** Defaults to NOTION_TOKEN, then NOTION_API_KEY. */
  token?: string;
  /** `replace` (default) rewrites the day's row; `append` grows it. */
  mode?: "replace" | "append";
  /** `false` returns `skipped` without publishing. */
  enabled?: boolean;
};

export const infraDeliverNotion = task({
  id: "infra-deliver-notion",
  // Covers a transient Notion 5xx or a 429. Safe: the title-keyed upsert cannot
  // create a duplicate row, and `replace` clears before writing.
  retry: { maxAttempts: 2 },
  run: async (payload: InfraDeliverNotionPayload): Promise<InfraDeliveryOutcome> => {
    logger.info("starting infra-deliver-notion");
    if (payload.enabled === false) {
      return infraSkipped("notion", "disabled by caller");
    }

    const token = payload.token ?? notionTokenFromEnv();
    if (!token) {
      return infraSkipped("notion", "neither NOTION_TOKEN nor NOTION_API_KEY set, and no token in payload");
    }

    const databaseId = payload.databaseId ?? process.env.NOTION_DATABASE_ID ?? "";
    if (!databaseId) {
      return infraSkipped("notion", "NOTION_DATABASE_ID not set and no databaseId in payload");
    }

    const result = await upsertNotionPage({
      token,
      databaseId,
      title: payload.title ?? `Infra health — ${payload.report.date}`,
      markdown: buildMarkdown(payload.report),
      ...(payload.mode ? { mode: payload.mode } : {}),
    });

    logger.info("infra-deliver-notion: published report", {
      date: payload.report.date,
      overallStatus: payload.report.overallStatus,
      pageId: result.pageId,
      created: result.created,
    });
    logger.info("completed infra-deliver-notion", { pageId: result.pageId, created: result.created });

    return {
      destination: "notion",
      status: "delivered",
      url: result.url,
      pageId: result.pageId,
      created: result.created,
    };
  },
});
