import { schedules, logger } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { MissingAnalyticsTokenError, makeGraphqlFetch, runQuotaCheck } from "../lib/cfAnalytics.js";
import type { QuotaState } from "../lib/cfAnalytics.js";
import { postSlackAlert } from "../lib/slackAlert.js";
import { previousRunOutput } from "./tasks/previous-run-output.js";

/**
 * Hourly Workers-quota alert (datacrew-site#241). Alerts at 60k and 80k daily
 * invocations, and on any client IP over 5k requests/hour on datacrew.space.
 *
 * Secrets: `CF_ANALYTICS_TOKEN` (dedicated; Account Analytics:Read + Zone
 * Analytics:Read) fails loudly when absent. `CF_ACCOUNT_ID` / `CF_ZONE_ID`
 * already live in Infisical `/infrastructure`. Logic: `../lib/cfAnalytics.ts`.
 */
const INFRA_PATH = { path: "/infrastructure", recursive: false } as const;

export type QuotaOutput = QuotaState & { invocations: number; heavyClientCount: number };

export const workersQuotaAlert = schedules.task({
  id: "workers-quota-alert",
  cron: { pattern: "7 * * * *", environments: ["PRODUCTION"] },
  retry: { maxAttempts: 1 },
  run: async (): Promise<QuotaOutput> => {
    // Default path `/datacrew`, where the other watchdog secrets live. A lookup
    // failure or empty value is the same loud error naming the scopes to create.
    const token = await getSecret("CF_ANALYTICS_TOKEN", { recursive: false }).catch(() => "");
    if (!token) throw new MissingAnalyticsTokenError();
    const [accountId, zoneId] = await Promise.all([
      getSecret("CF_ACCOUNT_ID", INFRA_PATH),
      getSecret("CF_ZONE_ID", INFRA_PATH),
    ]);
    const result = await runQuotaCheck({
      gql: makeGraphqlFetch(token),
      accountId,
      zoneId,
      previous: () => previousRunOutput<QuotaState>("workers-quota-alert"),
      notify: postSlackAlert,
      now: new Date(),
    });
    logger.info("workers-quota-alert: done", {
      invocations: result.invocations,
      heavyClients: result.heavyClients.length,
      alerts: result.alerts,
    });
    return { ...result.state, invocations: result.invocations, heavyClientCount: result.heavyClients.length };
  },
});
