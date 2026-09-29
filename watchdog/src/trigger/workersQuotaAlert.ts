import { schedules, logger } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { MissingAnalyticsTokenError, isSecretNotFound, makeGraphqlFetch, runQuotaCheck } from "../lib/cfAnalytics.js";
import type { QuotaState } from "../lib/cfAnalytics.js";
import { postSlackAlert } from "../lib/slackAlert.js";
import { previousRunOutput } from "./tasks/previous-run-output.js";

/**
 * Workers-quota alert every 15 minutes (datacrew-site#241). Alerts at 60k and
 * 80k daily invocations, and on any client IP over 5k requests/hour on
 * datacrew.space. Every 15 minutes, not hourly, so a fast flood cannot jump
 * from under 60k to past the 100k cap between polls; the GraphQL calls go to
 * Cloudflare, not datacrew.space, so polling costs no invocations.
 *
 * Secrets: `CF_ANALYTICS_TOKEN` (dedicated; Account Analytics:Read + Zone
 * Analytics:Read) fails loudly when absent. `CF_ACCOUNT_ID` / `CF_ZONE_ID`
 * already live in Infisical `/infrastructure`. Logic: `../lib/cfAnalytics.ts`.
 */
const INFRA_PATH = { path: "/infrastructure", recursive: false } as const;

export type QuotaOutput = QuotaState & { invocations: number; heavyClientCount: number; pagesError: string | null };

export const workersQuotaAlert = schedules.task({
  id: "workers-quota-alert",
  cron: { pattern: "*/15 * * * *", environments: ["PRODUCTION"] },
  retry: { maxAttempts: 1 },
  run: async (): Promise<QuotaOutput> => {
    logger.info("starting workers-quota-alert");
    // Default path `/datacrew`, where the other watchdog secrets live. Only a genuinely
    // absent secret is the "create the token" error; Infisical/auth failures bubble up.
    let token: string;
    try {
      token = await getSecret("CF_ANALYTICS_TOKEN", { recursive: false });
    } catch (error) {
      if (isSecretNotFound(error)) throw new MissingAnalyticsTokenError();
      throw error;
    }
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
      siteUp: async () => {
        const out = await previousRunOutput<{ consecutiveFailures?: number }>("site-synthetic-check");
        return out ? out.consecutiveFailures === 0 : null;
      },
      notify: postSlackAlert,
      now: new Date(),
    });
    if (result.pagesError) logger.error("workers-quota-alert: Pages query failed, reported Workers-only count", { error: result.pagesError });
    logger.info("completed workers-quota-alert", {
      workersInvocations: result.counts.workers,
      pagesInvocations: result.counts.pages,
      invocations: result.invocations,
      heavyClients: result.heavyClients.length,
      alerts: result.alerts,
    });
    return { ...result.state, invocations: result.invocations, heavyClientCount: result.heavyClients.length, pagesError: result.pagesError };
  },
});
