import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret, cloneRepo, runUv } from "@datacrew/trigger-shared";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Replaces `.github/workflows/ensure-reflection-schedule.yml` (daily
 * `15 12 * * *` UTC + `workflow_dispatch`), per ADR-054
 * (`.agents/adrs/ADR-054-trigger-dev-is-the-orchestration-layer-not-github-actions.md`).
 *
 * Reconciliation task, no human first-class participant, keeps another
 * system (Letta's reflection schedule) correct on a cron — squarely
 * `watchdog`'s domain per `docs/ADR-001-project-boundaries.md`.
 *
 * TODO (blocking, found during the port, 2026-09-09): the script this
 * workflow ran, `libraries/mdrag-agents/scripts/register_reflection_schedule.py`,
 * does not exist anywhere in this checkout. `mdrag-agents` was merged into
 * `libraries/mdrag`, but this specific script was not carried over in that
 * merge (confirmed: no `reflection_schedule`/`SECOND_BRAIN_REFLECTION` hits
 * anywhere under `libraries/mdrag`) — a real gap, not just a stale path.
 * Ported faithfully to the original script path/env contract so this is a
 * mechanical fix once the script is rebuilt (or the equivalent logic is
 * added to `libraries/mdrag`) — do not deploy before resolving that gap.
 */

const SIMPLE_DISCORD_BOT_REPO = "https://github.com/jaewilson07/simpleDiscordBot.git";
// Original workflow read these from GH Actions `vars` (not `secrets`), with
// literal fallback defaults baked into the workflow file itself — preserved
// here as the same hardcoded fallbacks rather than promoting them to
// Infisical secrets they never were.
const DEFAULT_AGENT_ID = "agent-64b31ced-0bae-4cde-bb9b-af4a9f974588";
const DEFAULT_CONVERSATION_ID = "conv-cf160695-f847-43b0-b223-10cfa28fa3b0";

type EnsureReflectionSchedulePayload = {
  timestamp: Date | string;
  timezone: string;
};

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    console.warn(
      "Skipping Trigger.dev tags outside managed runtime:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function runEnsureReflectionSchedule(): Promise<{ status: string }> {
  await safeAddTags(["reflection-schedule", "letta", "mdrag"]);
  logger.info("starting ensure-reflection-schedule");

  const [ghPat, lettaApiKey] = await Promise.all([
    getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
    // Letta Cloud key lives at /letta, not /datacrew — matches
    // trigger.config.ts's own SYNCED_SECRETS comment on this distinction.
    getSecret("LETTA_API_KEY", { path: "/letta" }),
  ]);

  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reflection-schedule-"));
  const repoDir = path.join(scratchRoot, "simpleDiscordBot");

  try {
    logger.info("cloning simpleDiscordBot", { repoDir });
    await cloneRepo(SIMPLE_DISCORD_BOT_REPO, repoDir, ghPat);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LETTA_API_KEY: lettaApiKey,
      LETTA_BASE_URL: process.env.LETTA_BASE_URL ?? "",
      SECOND_BRAIN_REFLECTION_AGENT_ID: process.env.SECOND_BRAIN_REFLECTION_AGENT_ID ?? DEFAULT_AGENT_ID,
      SECOND_BRAIN_REFLECTION_CONVERSATION_ID:
        process.env.SECOND_BRAIN_REFLECTION_CONVERSATION_ID ?? DEFAULT_CONVERSATION_ID,
      SECOND_BRAIN_REFLECTION_CRON: process.env.SECOND_BRAIN_REFLECTION_CRON ?? "",
      SECOND_BRAIN_REFLECTION_MESSAGE: process.env.SECOND_BRAIN_REFLECTION_MESSAGE ?? "",
    };

    const result = await runUv(
      repoDir,
      ["run", "python", "libraries/mdrag-agents/scripts/register_reflection_schedule.py"],
      { env, secrets: [lettaApiKey, ghPat] }
    );
    logger.info("ensure-reflection-schedule script finished", { stdoutTail: result.stdout.slice(-2000) });

    return { status: "completed" };
  } catch (error) {
    logger.error("failed ensure-reflection-schedule", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
}

export const ensureReflectionSchedule = schedules.task({
  id: "ensure-reflection-schedule",
  cron: {
    pattern: "15 12 * * *",
    environments: ["PRODUCTION"],
  },
  maxDuration: 600,
  run: async (_payload: EnsureReflectionSchedulePayload) => runEnsureReflectionSchedule(),
});
