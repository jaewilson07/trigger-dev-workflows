import { schedules, logger } from "@trigger.dev/sdk";
import { SITE_CHECKS, fetchProbe, runSiteCheck } from "../lib/siteMonitorCore.js";
import type { SiteCheckResult, SiteCheckState } from "../lib/siteMonitorCore.js";
import { postSlackAlert } from "../lib/slackAlert.js";
import { previousRunOutput } from "./tasks/previous-run-output.js";

/**
 * Synthetic check for datacrew.space, every 5 minutes (datacrew-site#241).
 * Asserts app-only signals (HSTS header the Next.js app adds, package index
 * body) so the static `fail_open` 404 served after the Workers quota runs out
 * cannot pass as healthy. Alerts to Slack after 2 consecutive failing runs.
 * Logic lives in `../lib/siteMonitorCore.ts`.
 */
const SELF_ID = "site-synthetic-check";

export const siteSyntheticCheck = schedules.task({
  id: "site-synthetic-check",
  cron: { pattern: "*/5 * * * *", environments: ["PRODUCTION"] },
  retry: { maxAttempts: 1 },
  run: async (): Promise<SiteCheckResult> => {
    logger.info("starting site-synthetic-check", { checks: SITE_CHECKS.map((c) => c.name) });
    const result = await runSiteCheck({
      probe: fetchProbe,
      previous: async () => {
        const out = await previousRunOutput<Partial<SiteCheckState>>(SELF_ID);
        return { consecutiveFailures: out?.consecutiveFailures ?? 0 };
      },
      notify: postSlackAlert,
    });
    for (const o of result.outcomes.filter((x) => !x.ok)) {
      logger.warn("site-synthetic-check: failed", { name: o.name, url: o.url, reason: o.reason });
    }
    logger.info("completed site-synthetic-check", {
      consecutiveFailures: result.consecutiveFailures,
      action: result.action,
    });
    return result;
  },
});
