import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret, cloneRepo, runUv } from "@datacrew/trigger-shared";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Replaces `.github/workflows/daily-standup.yml` (`13:00 UTC daily` +
 * `workflow_dispatch`), per ADR-054
 * (`.agents/adrs/ADR-054-trigger-dev-is-the-orchestration-layer-not-github-actions.md`).
 *
 * `executive-assistant` / `assistant` domain (docs/ADR-001-project-boundaries.md):
 * exists to tell Jae something (a standup brief), posted to Discord.
 *
 * Two steps, same as the original workflow:
 *   1. `audit-branch-protection` (enforced — fails the run if any configured
 *      repo is unprotected, same as the original's `continue-on-error: false`).
 *   2. `run-daily-standup` — builds the brief, optionally posts to Discord.
 *
 * FLAGGED, NOT FIXED (found during the port, 2026-09-09): both scripts
 * (`.agents/runbooks/audit-branch-protection/scripts/main.py`,
 * `alix/.agents/runbooks/run-daily-standup/scripts/main.py`) walk `git log`
 * / `git status` across MULTIPLE nested repo checkouts inside this monorepo
 * (simpleDiscordBot, alix, datacrew, trigger-dev-workflows, …) — several of
 * which are independently-git-cloned working directories, not paths tracked
 * by simpleDiscordBot's own git history. A fresh `git clone --depth 1` of
 * simpleDiscordBot alone (the pattern used here, matching every other
 * git-uv-based task in this project) reproduces only simpleDiscordBot's own
 * tracked tree — it will NOT recreate those sibling checkouts. The original
 * GitHub Actions workflow had the exact same gap (its only checkout step was
 * `actions/checkout@v4` on simpleDiscordBot itself), so this is not a
 * regression introduced by the port — but it means the standup brief this
 * task produces may already have been (and will continue to be) missing
 * cross-repo commit/dirty-tree data the scripts were written to surface. A
 * human should decide whether to (a) accept this gap as pre-existing, (b)
 * have this task clone each sibling repo explicitly before running the
 * scripts, or (c) run this one via SSH against the live host checkout
 * instead of an ephemeral container (see the `vps-ssh` skill).
 */

const SIMPLE_DISCORD_BOT_REPO = "https://github.com/jaewilson07/simpleDiscordBot.git";

type DailyStandupPayload = {
  timestamp: Date | string;
  timezone: string;
  /** Matches the original workflow_dispatch inputs. */
  hours?: number;
  post_to_discord?: boolean;
  checkpoint_mode?: "advisory" | "enforce";
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

async function runDailyStandup(payload: DailyStandupPayload): Promise<{ status: string }> {
  const hours = payload.hours ?? 24;
  const postToDiscord = payload.post_to_discord ?? true;
  const checkpointMode = payload.checkpoint_mode ?? "advisory";

  await safeAddTags(["daily-standup", "assistant"]);
  logger.info("starting daily-standup", { hours, postToDiscord, checkpointMode });

  const [ghPat, discordWebhookUrl] = await Promise.all([
    getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false }),
    // Not in trigger.config.ts's baked SYNCED_SECRETS allowlist — fetched at
    // runtime instead so a missing/renamed key fails only this task, not
    // every deploy (see infisical.ts's own comment on why syncEnvVars throws
    // hard for ANY missing allowlisted name).
    getSecret("DAILY_STANDUP_DISCORD_WEBHOOK_URL", { path: "/datacrew" }).catch((error) => {
      logger.warn("DAILY_STANDUP_DISCORD_WEBHOOK_URL not found — Discord post will be skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }),
  ]);

  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "daily-standup-"));
  const repoDir = path.join(scratchRoot, "simpleDiscordBot");

  try {
    logger.info("cloning simpleDiscordBot", { repoDir });
    await cloneRepo(SIMPLE_DISCORD_BOT_REPO, repoDir, ghPat);

    // GITHUB_STANDUP_REPOS / GITHUB_PROTECTED_BRANCH / GITHUB_PROJECT_OWNER /
    // GITHUB_PROJECT_NUMBER were GH Actions `vars` (org/repo config, not
    // secrets) — read from this task's own env with the same defaults the
    // original workflow used, set them in this project's env if the standup
    // needs to target something other than the defaults.
    const sharedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_STANDUP_REPOS: process.env.GITHUB_STANDUP_REPOS ?? "",
      GITHUB_PROTECTED_BRANCH: process.env.GITHUB_PROTECTED_BRANCH ?? "main",
      GITHUB_PROJECT_OWNER: process.env.GITHUB_PROJECT_OWNER ?? "",
      GITHUB_PROJECT_NUMBER: process.env.GITHUB_PROJECT_NUMBER ?? "",
      GITHUB_TOKEN: ghPat,
    };

    logger.info("running audit-branch-protection (enforced)");
    await runUv(
      repoDir,
      [
        "run",
        "--no-project",
        "--with",
        "python-dotenv",
        "python",
        ".agents/runbooks/audit-branch-protection/scripts/main.py",
        "--enforce",
      ],
      { env: sharedEnv, secrets: [ghPat] }
    );

    const standupArgs = [
      "run",
      "python",
      "alix/.agents/runbooks/run-daily-standup/scripts/main.py",
      "--hours",
      String(hours),
      "--checkpoint-mode",
      checkpointMode,
    ];
    if (postToDiscord && discordWebhookUrl) {
      standupArgs.push("--post-to-discord");
    }

    logger.info("generating standup brief", { postToDiscord: postToDiscord && !!discordWebhookUrl });
    const result = await runUv(repoDir, standupArgs, {
      env: { ...sharedEnv, DAILY_STANDUP_DISCORD_WEBHOOK_URL: discordWebhookUrl },
      secrets: [ghPat, discordWebhookUrl].filter(Boolean),
    });
    logger.info("daily-standup script finished", { stdoutTail: result.stdout.slice(-2000) });

    // Original workflow also uploaded `data/EXPORTS/daily-standup/` as a CI
    // artifact for later download — trigger.dev has no direct equivalent.
    // Left un-ported; if that artifact matters, read it from `repoDir`
    // before `finally` cleans it up and deliver it via one of this project's
    // existing delivery tasks (deliver-slack/deliver-gdoc/deliver-mdrag).
    return { status: "completed" };
  } catch (error) {
    logger.error("failed daily-standup", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
}

export const dailyStandup = schedules.task({
  id: "daily-standup",
  cron: {
    pattern: "0 13 * * *",
    environments: ["PRODUCTION"],
  },
  maxDuration: 1200,
  run: async (payload: DailyStandupPayload) => runDailyStandup(payload),
});
