import { task, logger } from "@trigger.dev/sdk";
import { upsertMarkdownDoc } from "../../lib/google-docs.js";
import { buildMarkdown } from "../../lib/infra-health.js";
import { infraSkipped } from "../../lib/infra-delivery.js";
import type { InfraHealthReport } from "../../lib/infra-health.js";
import type { InfraDeliveryOutcome } from "../../lib/infra-delivery.js";

/**
 * Google Doc delivery for the infra health report — the SECOND destination,
 * which is the whole point of giving this workflow a delivery half.
 *
 * Slack is a notification: you read it once and it scrolls away. A daily health
 * report is also a record you want to look back through — "when did caddy first
 * go out of date" — and Drive's markdown import renders `buildMarkdown`'s
 * tables as real Doc tables.
 *
 * TWO MODES, chosen by whether a document id is supplied — the same shape
 * `executive-assistant/tasks/deliver-gdoc.ts` uses:
 *   - `WATCHDOG_GDOC_DOCUMENT_ID` set → that doc is overwritten in place. One
 *     stable URL to bookmark, always showing today's report. The right default
 *     for a daily cron.
 *   - unset → a new dated doc per run, optionally in `WATCHDOG_GDOC_FOLDER_ID`.
 *
 * Unconfigured is `skipped`, not an error: a watchdog deployment with no Google
 * credentials is a normal state, and the Slack post still lands.
 */
export type InfraDeliverGDocPayload = {
  report: InfraHealthReport;
  /** Defaults to WATCHDOG_GDOC_OWNER_EMAIL. The Google identity, not a Slack id. */
  ownerEmail?: string;
  /** Defaults to WATCHDOG_GDOC_DOCUMENT_ID. Set → overwrite in place. */
  documentId?: string;
  /** Defaults to WATCHDOG_GDOC_FOLDER_ID. Only used when creating. */
  folderId?: string;
  /** Defaults to `Infra health report — <date>`. */
  title?: string;
  /** `false` returns `skipped` without publishing. */
  enabled?: boolean;
};

export const infraDeliverGDoc = task({
  id: "infra-deliver-gdoc",
  // Importing `googleapis` pulls in the whole discovery surface and SIGKILLs on
  // the 0.5 GB default before any user code runs, which reads as an
  // unexplained crash rather than an OOM. Measured in this repo's other two
  // projects; carried here with the code.
  machine: "small-2x",
  // Covers a transient auth-service or Drive 5xx. Safe in both modes: overwrite
  // is idempotent, and a duplicate dated doc is recoverable in a way a missing
  // report is not.
  retry: { maxAttempts: 2 },
  run: async (payload: InfraDeliverGDocPayload): Promise<InfraDeliveryOutcome> => {
    if (payload.enabled === false) {
      return infraSkipped("gdoc", "disabled by caller");
    }

    const ownerEmail = payload.ownerEmail ?? process.env.WATCHDOG_GDOC_OWNER_EMAIL ?? "";
    if (!ownerEmail) {
      return infraSkipped("gdoc", "WATCHDOG_GDOC_OWNER_EMAIL not set and no ownerEmail in payload");
    }
    if (!process.env.GOOGLE_TOKEN_API_KEY) {
      return infraSkipped("gdoc", "GOOGLE_TOKEN_API_KEY not set");
    }

    const documentId = payload.documentId ?? process.env.WATCHDOG_GDOC_DOCUMENT_ID ?? "";
    const folderId = payload.folderId ?? process.env.WATCHDOG_GDOC_FOLDER_ID ?? "";

    const result = await upsertMarkdownDoc({
      ownerEmail,
      title: payload.title ?? `Infra health report — ${payload.report.date}`,
      markdown: buildMarkdown(payload.report),
      ...(documentId ? { documentId } : {}),
      ...(folderId ? { folderId } : {}),
    });

    logger.info("infra-deliver-gdoc: published report", {
      ownerEmail,
      documentId: result.documentId,
      created: result.created,
      overallStatus: payload.report.overallStatus,
    });

    return {
      destination: "gdoc",
      status: "delivered",
      url: result.documentUrl,
      documentId: result.documentId,
      created: result.created,
    };
  },
});
