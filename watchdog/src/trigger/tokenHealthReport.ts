import { schedules, logger, tags } from "@trigger.dev/sdk";
import {
  buildReport,
  formatAlertMessage,
  formatSummary,
  groupByValue,
  trackSecrets,
  updateDeadSinceState,
} from "../lib/tokenHealthCore.js";
import { checkLivenessForGroups, fetchAllSecretRecords, loadDeadSinceState, saveDeadSinceState } from "../lib/tokenHealthScan.js";

/**
 * Daily token-health sweep — 2026-09-28's incident: four Infisical-held
 * `dc_`/`mat_` API tokens had been revoked weeks earlier and nothing
 * noticed; consumers just 401'd until someone happened to look. This task
 * closes that gap: once a day, list every `dc_`/`mat_`-prefixed secret
 * across the scanned Infisical folders/environments
 * (`../lib/tokenHealthScan.ts`'s `SCAN_PATHS`/`SCAN_ENVIRONMENTS`), liveness
 * check each DISTINCT value against mdrag's `/api/v1/users/me` (dc_ and
 * mat_ are both plain `Authorization: Bearer` tokens mdrag accepts — see
 * mdrag's `authenticate-to-mdrag` skill), and alert on any dead value plus
 * warn on any value held directly under more than one name.
 *
 * Everything decision-y (classify, dedupe, build the report, format the
 * alert) lives in `../lib/tokenHealthCore.ts` (pure, `hashValue` never
 * stores a raw token). The Infisical listing, the liveness fetch, and the
 * dead-since state round-trip live in `../lib/tokenHealthScan.ts`. This file
 * is a thin scheduled entry point, same shape as every other watchdog report.
 *
 * ## Alert path — reused, not invented
 *
 * This task does not post anywhere itself. It throws when `deadEntries` is
 * non-empty, and `failureAlertReport.ts`'s 30-minute sweep
 * (`../lib/failureAlertReporter.ts`) is what turns a task's own failing runs
 * into a filed/commented-on GitHub issue (>=2 consecutive failures, or >=2
 * terminal runs on the current deploy with zero successes) — the same path
 * every other watchdog task's genuine failures already go through. A
 * duplicate-value finding alone is not thrown (it is not breakage, just
 * hygiene), only logged as a warning — see `formatAlertMessage`'s doc
 * comment.
 *
 * ## Cron slot
 *
 * `11:00 UTC` daily — the 9am and 10am hours are fully claimed by the
 * vendor-docs-sync tasks' five-minute stagger (`vendor-docs/*.ts`, up to
 * `55 9 * * *`/`30 10 * * *`), and 12:15/14:00/15:00 are taken by
 * `reflectionScheduleEnsure`/`infraHealthReport`/`repoMonitorReport`. 11:00
 * is the first fully open daily hour.
 */

type SchedulePayload = {
  timestamp: Date | string;
  timezone: string;
};

export type TokenHealthReportResult = {
  status: "completed";
  distinctValuesChecked: number;
  deadCount: number;
  duplicateCount: number;
  unknownCount: number;
};

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    logger.warn("token-health-report: skipping tags outside managed runtime", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const tokenHealthReport = schedules.task({
  id: "token-health-report",
  cron: {
    pattern: "0 11 * * *",
    environments: ["PRODUCTION"],
  },
  maxDuration: 300,
  run: async (payload: SchedulePayload): Promise<TokenHealthReportResult> => {
    const timestampIso =
      payload.timestamp instanceof Date ? payload.timestamp.toISOString() : String(payload.timestamp);
    await safeAddTags(["token-health", "infisical", "mdrag", "watchdog"]);
    logger.info("starting token-health-report", { timestamp: timestampIso });

    const records = await fetchAllSecretRecords();
    const tracked = trackSecrets(records);
    const groups = groupByValue(tracked);

    const liveness = await checkLivenessForGroups(groups);
    const previousDeadSince = await loadDeadSinceState();
    const deadSinceByHash = new Map(Object.entries(previousDeadSince));
    const nowIso = new Date().toISOString();

    const report = buildReport(groups, liveness, deadSinceByHash, nowIso);

    const deadValues = groups.filter((g) => liveness.get(g.value) === "dead").map((g) => g.value);
    const nextState = updateDeadSinceState(previousDeadSince, deadValues, nowIso);
    await saveDeadSinceState(nextState);

    logger.info(formatSummary(report), {
      distinctValuesChecked: report.distinctValuesChecked,
      deadCount: report.deadEntries.length,
      duplicateCount: report.duplicates.length,
      unknownCount: report.unknownEntries.length,
    });

    if (report.duplicates.length > 0) {
      logger.warn("token-health-report: duplicate values under different names", {
        duplicates: report.duplicates,
      });
    }
    if (report.unknownEntries.length > 0) {
      logger.warn("token-health-report: some values could not be checked", {
        unknownEntries: report.unknownEntries,
      });
    }

    const alertMessage = formatAlertMessage(report);
    if (alertMessage) {
      logger.error(alertMessage);
      throw new Error(alertMessage);
    }

    return {
      status: "completed",
      distinctValuesChecked: report.distinctValuesChecked,
      deadCount: report.deadEntries.length,
      duplicateCount: report.duplicates.length,
      unknownCount: report.unknownEntries.length,
    };
  },
});
