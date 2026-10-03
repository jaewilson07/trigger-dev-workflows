import { schedules, logger } from "@trigger.dev/sdk";
import { getSecret, mdragBaseUrl, mdragCall, mdragServiceCredential } from "@datacrew/trigger-shared";
import { runHuntReporterSweep } from "../lib/huntReporterSweepCore.js";
import type { SweepOutput } from "../lib/huntReporterSweepCore.js";
import { previousRunOutput } from "./tasks/previous-run-output.js";

/**
 * The clock for mdrag's hunt reporter (mdrag#1984, mdrag PR #1996): every minute,
 * POST `/api/v1/internal/hunt-reporter/sweep`. mdrag owns the logic; this only
 * ticks. Idempotent and cheap when nothing changed.
 *
 * AUTH. The route admits only mdrag's internal service identity —
 * `X-Internal-Secret` with no user — and refuses a token. That is a "service"
 * credential in `mdrag-hop.ts`, so `MDRAG_URL` must be mdrag's DIRECT address:
 * wiki.datacrew.space strips the secret and `mdragCall` refuses it. The secret
 * comes from env `MDRAG_INTERNAL_SECRET`, else Infisical (`/mdrag`).
 *
 * Retry is off: the next tick is a minute away and the sweep is idempotent, so
 * a retry only stacks runs. Throws (run FAILS, visible to failure-alert-report)
 * on a non-2xx; warns when `behind`/`failed` persist (see the core).
 */
const SELF_ID = "mdrag-hunt-reporter-sweep";

export const mdragHuntReporterSweep = schedules.task({
  id: SELF_ID,
  cron: { pattern: "* * * * *", environments: ["PRODUCTION"] },
  retry: { maxAttempts: 1 },
  maxDuration: 60,
  run: async (): Promise<SweepOutput> => {
    logger.info("starting mdrag-hunt-reporter-sweep");
    const secret =
      (process.env.MDRAG_INTERNAL_SECRET ?? "").trim() ||
      (await getSecret("MDRAG_INTERNAL_SECRET", { path: "/mdrag", recursive: false }));
    const call = mdragCall("/api/v1/internal/hunt-reporter/sweep", mdragServiceCredential(secret), mdragBaseUrl());
    const result = await runHuntReporterSweep({
      call,
      previous: () => previousRunOutput<SweepOutput>(SELF_ID),
      warn: (message, data) => logger.warn(`${SELF_ID}: ${message}`, data),
    });
    logger.info("completed mdrag-hunt-reporter-sweep", { checked: result.checked, behind: result.behind, failed: result.failed.length });
    return result;
  },
});
