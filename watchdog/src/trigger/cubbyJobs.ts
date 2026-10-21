import { schedules, logger } from "@trigger.dev/sdk";
import { runCubbyJob, type CubbyJobResult } from "../lib/cubbyRunJob.js";
import { ssh2Transport } from "../lib/cubbyRunJobSsh2.js";
import { redactSecrets } from "../lib/redactSecrets.js";

/**
 * cubby's cron jobs, run from trigger.dev over SSH (DAT-1606; part of
 * jaewilson07/infra-baseline#9, replacing the cubby crontab). Each task calls
 * the forced-command runner on cubby (`run-job <job>`, DAT-1605).
 * Retries are OFF: the jobs commit, ingest and restart services.
 * Unreachable cubby => `skipped`, not a failure. See ../lib/cubbyRunJob.ts.
 */
async function runJob(job: string): Promise<CubbyJobResult> {
  logger.info("starting cubby job", { job });
  try {
    const result = await runCubbyJob(job, { transport: ssh2Transport });
    if (result.status === "skipped") {
      logger.warn("cubby job skipped", { job, reason: result.reason });
    } else {
      logger.info("completed cubby job", { job, outputTail: redactSecrets(result.outputTail) });
    }
    return result;
  } catch (err) {
    const e = err as Error & { exitCode?: number };
    logger.error("cubby job failed", { job, error: e.name, exitCode: e.exitCode, message: redactSecrets(e.message) });
    throw err;
  }
}

function cubbyTask(id: string, job: string, pattern: string) {
  return schedules.task({
    id,
    cron: { pattern, timezone: "America/Denver", environments: ["PRODUCTION"] },
    retry: { maxAttempts: 1 },
    maxDuration: 3600,
    run: async (): Promise<CubbyJobResult> => runJob(job),
  });
}

export const cubbyImproveSystem = cubbyTask("cubby-improve-system", "improve-system", "0 17 * * 5");
export const cubbySyncDocsToKb = cubbyTask("cubby-sync-docs-to-kb", "sync-docs-to-kb", "30 3 * * *");
export const cubbyUpdateLettaCode = cubbyTask("cubby-update-letta-code", "update-letta-code", "0 6 * * 5");
export const cubbyClaudeMemoryToKb = cubbyTask("cubby-claude-memory-to-kb", "claude-memory-to-kb", "45 2 * * *");
export const cubbyDiaryFromTranscripts = cubbyTask("cubby-diary-from-transcripts", "diary-from-transcripts", "0 3 * * *");
