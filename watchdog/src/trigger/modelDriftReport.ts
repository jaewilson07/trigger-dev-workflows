import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import manifest from "../config/model-watch.json" with { type: "json" };
import {
  createHfClient,
  createIssueClient,
  runModelDriftSweep,
  type ModelWatchManifest,
} from "../lib/model-drift.js";

/**
 * Weekly model-drift check: are there newer revisions, new quant files, or new
 * family repos on HuggingFace for the models self-hosted on cubby? Files a
 * GitHub issue in `jaewilson07/infra-cubby` per change, deduped by hidden
 * markers so a revision is never filed twice (open or closed).
 *
 * What to watch: `../config/model-watch.json`. Decisions and state model:
 * `../lib/model-drift.ts`. Issues are filed with `JAEWILSON07_GH_PAT`, the same
 * token `failureAlertReport.ts` and every vendor-docs ingest already use.
 * If that token cannot reach infra-cubby the sweep files in the manifest's
 * fallback repo and says so in the issue body.
 *
 * Schedule: Mondays 16:00 UTC (10:00 MDT).
 */

type SchedulePayload = { timestamp: Date; timezone: string };

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    logger.warn("model-drift-report: skipping tags outside managed runtime", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const modelDriftReport = schedules.task({
  id: "model-drift-report",
  cron: { pattern: "0 16 * * 1", environments: ["PRODUCTION"] },
  run: async (payload: SchedulePayload) => {
    await safeAddTags(["model-drift", "huggingface", "github"]);
    logger.info("starting model-drift-report", { timestamp: payload.timestamp.toISOString() });
    const m = manifest as ModelWatchManifest;
    const ghToken = await getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false });

    const result = await runModelDriftSweep({
      manifest: m,
      hf: createHfClient(),
      primary: createIssueClient(ghToken, m.issueRepo),
      fallback: createIssueClient(ghToken, m.fallbackIssueRepo),
    });

    for (const f of result.findings) {
      logger.info(`model-drift-report: ${f.action} ${f.kind} issue for ${f.modelId}`, {
        repo: f.repo,
        issueUrl: f.issueUrl,
      });
    }
    for (const e of result.errors) logger.warn("model-drift-report: check error", { error: e });
    logger.info("model-drift-report: complete", {
      timestamp: payload.timestamp.toISOString(),
      issueRepo: result.issueRepo,
      checked: result.checked,
      filed: result.findings.filter((f) => f.action === "filed").length,
      deduped: result.findings.filter((f) => f.action === "deduped").length,
      errorCount: result.errors.length,
    });

    // A check that could not run is an error worth a failed run (failure-alert
    // then files it), but only after every other check was still attempted.
    if (result.errors.length && result.errors.length === result.checked) {
      throw new Error(`model-drift-report: every check failed: ${result.errors[0]}`);
    }
    return {
      filed: result.findings.filter((f) => f.action === "filed").length,
      errors: result.errors.length,
    };
  },
});
