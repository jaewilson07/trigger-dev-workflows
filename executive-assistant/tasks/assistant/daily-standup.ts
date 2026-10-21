import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret, cloneRepo, runUv } from "@datacrew/trigger-shared";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireSyncedEnv } from "../../lib/require-env.js";
import { assertGhAvailable } from "../../lib/require-gh.js";

/**
 * Replaces `.github/workflows/daily-standup.yml` (`13:00 UTC daily` +
 * `workflow_dispatch`), per infra-baseline ADR-054
 * (`.agents/adrs/ADR-054-trigger-dev-is-the-orchestration-layer-not-github-actions.md`
 * in `jaewilson07/infra-baseline`).
 *
 * `executive-assistant` / `assistant` domain (docs/ADR-001-project-boundaries.md):
 * exists to tell Jae something (a standup brief), posted to Discord.
 *
 * Two steps, same as the original workflow:
 *   1. `audit-branch-protection` (enforced — fails the run if any configured
 *      repo is unprotected, same as the original's `continue-on-error: false`).
 *   2. `run-daily-standup` — builds the brief, optionally posts to Discord.
 *
 * LAYOUT (changed 2026-10-19, simpleDiscordBot umbrella retired,
 * jaewilson07/infra-baseline#9): the two scripts no longer live in one
 * monorepo checkout. This task clones each owning repo as its own flat
 * directory under the scratch root and runs the script from there:
 *   - `audit-branch-protection` from `jaewilson07/infra-baseline`
 *     (`runbooks/audit-branch-protection/scripts/main.py`, stdlib only).
 *   - `run-daily-standup` from `jaewilson07/alix_discordbot`
 *     (`.agents/runbooks/run-daily-standup/scripts/main.py`).
 * Before, both ran out of a fresh `simpleDiscordBot` clone with a second
 * clone of alix_discordbot nested at `alix/`.
 *
 * STILL A GAP, owned by `jaewilson07/alix_discordbot` (not this repo): the
 * standup script's `main()` derives `repo_root` from its own location
 * (`Path(__file__).resolve().parents[4]`) and `_tracked_paths()` looks for
 * umbrella-style sibling directories (`alix`, `datacrew`, `slack-overlord`,
 * `libraries/*`) inside it. In this shape `repo_root` is the alix_discordbot
 * checkout, none of those exist, so `_tracked_paths()` returns `[]` and the
 * "Yesterday" (commits) and "Blockers" (dirty working tree) sections of the
 * brief are always empty. That half of the standup only makes sense against a
 * long-lived host checkout holding the sibling repos (e.g. `~/GitHub`), not an
 * ephemeral container; it needs either an explicit repo-root argument in that
 * script or to run on a host. The GitHub issues/PRs/branch-protection half is
 * driven by `GITHUB_STANDUP_REPOS`, not by `repo_root`, and is unaffected.
 */

const INFRA_BASELINE_REPO = "https://github.com/jaewilson07/infra-baseline.git";
const ALIX_DISCORDBOT_REPO = "https://github.com/jaewilson07/alix_discordbot.git";

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

  // Fail loudly, up front, if `gh` isn't on PATH — both scripts this task
  // runs shell out to it and otherwise degrade *silently* to empty/vacuous
  // results (see `require-gh.ts`'s doc comment: `--enforce` on
  // audit-branch-protection would exit 0 as if every repo were verified
  // protected, purely because `gh` wasn't there to check). This should
  // always resolve now that `trigger.config.ts` bakes `gh` into the image
  // (`gitAndUv({ gh: true })`) — checking again at runtime catches a
  // deploy that didn't pick up that build extension, rather than shipping
  // a standup brief that quietly reports nothing.
  await assertGhAvailable();

  // JAEWILSON07_GH_PAT: switched 2026-09-26 from a runtime getSecret() call
  // (needs INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET as this project's
  // OWN dashboard env vars, never set for executive-assistant — every run
  // failed with "Missing INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET"
  // before ever reaching the clone step) to trigger.config.ts's build-time
  // SYNCED_SECRETS sync, the pattern every other task in this project
  // already uses. See lib/require-env.ts's doc comment for the full story.
  const ghPat = requireSyncedEnv("JAEWILSON07_GH_PAT");
  // Deliberately NOT in trigger.config.ts's baked SYNCED_SECRETS allowlist —
  // fetched at runtime instead so a missing/renamed key fails only this
  // task, not every deploy (see infisical.ts's own comment on why
  // syncEnvVars throws hard for ANY missing allowlisted name). This one
  // still depends on INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET being set
  // as a runtime dashboard var for this project — not yet true as of
  // 2026-09-26 — so today this always falls into the `.catch()` below and
  // skips the Discord post. That's the existing, intended degrade path;
  // fixing it needs INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET added to
  // this project's dashboard env vars (see PR description), not a code
  // change.
  const discordWebhookUrl = await getSecret("DAILY_STANDUP_DISCORD_WEBHOOK_URL", {
    path: "/datacrew",
  }).catch((error) => {
    logger.warn("DAILY_STANDUP_DISCORD_WEBHOOK_URL not found — Discord post will be skipped", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  });

  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "daily-standup-"));
  const infraBaselineDir = path.join(scratchRoot, "infra-baseline");
  const alixDir = path.join(scratchRoot, "alix_discordbot");

  try {
    logger.info("cloning infra-baseline", { infraBaselineDir });
    await cloneRepo(INFRA_BASELINE_REPO, infraBaselineDir, ghPat);

    logger.info("cloning alix_discordbot", { alixDir });
    await cloneRepo(ALIX_DISCORDBOT_REPO, alixDir, ghPat);

    // GITHUB_STANDUP_REPOS / GITHUB_PROTECTED_BRANCH / GITHUB_PROJECT_OWNER /
    // GITHUB_PROJECT_NUMBER were GH Actions `vars` (org/repo config, not
    // secrets) — read from this task's own env with the same defaults the
    // original workflow used, set them in this project's env if the standup
    // needs to target something other than the defaults.
    //
    // Evidence for "" being the right default (not a placeholder nobody
    // filled in): `git show 98ba24555:.github/workflows/daily-standup.yml`
    // (umbrella jaewilson07/simpleDiscordBot, the last version before deletion in #374) set all
    // four the same way — `${{ vars.GITHUB_STANDUP_REPOS }}` etc, no `||`
    // fallback in the workflow YAML itself — so an unset repo/org variable
    // resolved to the empty string there too. Both Python scripts already
    // treat "" as "use my own hardcoded default list", not "no repos" or
    // "all repos":
    //   - infra-baseline's `audit-branch-protection/scripts/main.py` falls
    //     back to a hardcoded list spanning most of this org.
    //   - alix_discordbot's `run-daily-standup/scripts/main.py`
    //     `_parse_standup_repos()` falls back to its own hardcoded list (as of
    //     2026-10-19 it still names the archived `jaewilson07/simpleDiscordBot`;
    //     fix it there, or set GITHUB_STANDUP_REPOS here).
    // So leaving these unset in this Trigger.dev project reproduces the
    // original (never-verified-working) behavior exactly; there's no
    // evidence of a different intended value to recover from history. Set
    // GITHUB_STANDUP_REPOS/GITHUB_PROJECT_OWNER/GITHUB_PROJECT_NUMBER as
    // this project's own dashboard env vars if the standup should track a
    // different or narrower repo/project list than those two hardcoded
    // defaults.
    const sharedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_STANDUP_REPOS: process.env.GITHUB_STANDUP_REPOS ?? "",
      GITHUB_PROTECTED_BRANCH: process.env.GITHUB_PROTECTED_BRANCH ?? "main",
      GITHUB_PROJECT_OWNER: process.env.GITHUB_PROJECT_OWNER ?? "",
      GITHUB_PROJECT_NUMBER: process.env.GITHUB_PROJECT_NUMBER ?? "",
      GITHUB_TOKEN: ghPat,
    };

    // `--enforce` here only fails the run (exit 2) when a repo's status is
    // literally `"unprotected"`. Verified by reading
    // `_check_protection`/`main()` in the script: a repo `gh` can't reach
    // for any other reason — no `gh` binary (`"unknown-no-gh"`), no access
    // (`"unknown-no-access"`), or an unrecognized API response
    // (`"unknown"`) — is bucketed separately and never makes `unprotected`
    // non-empty, so `--enforce` exits 0 for those cases too: a `gh`-less
    // environment would pass this "enforced" gate vacuously, reporting
    // every repo as merely "unknown" rather than failing the run. The
    // `assertGhAvailable()` call above closes that specific hole for this
    // task (it throws before this step ever runs if `gh` is missing); it
    // does not change the script's own exit-code logic, which still treats
    // `unknown-no-access` the same permissive way for repos this PAT
    // genuinely can't reach.
    logger.info("running audit-branch-protection (enforced)");
    // The script is stdlib-only, so no `--with` packages are needed.
    await runUv(
      infraBaselineDir,
      [
        "run",
        "--no-project",
        "python",
        "runbooks/audit-branch-protection/scripts/main.py",
        "--enforce",
      ],
      { env: sharedEnv, secrets: [ghPat] }
    );

    // `--no-project` (matching the audit-branch-protection call above):
    // without it, `uv run` from inside the alix_discordbot clone would
    // resolve that repo's own `pyproject.toml` (and its path/workspace
    // dependencies) — the standup script doesn't need or want that; it only imports
    // `env_loader` (via the `sys.path.insert` in its own source) plus two
    // third-party packages, both supplied explicitly here: `httpx` (the
    // Discord-webhook POST) and `python-dotenv` (`env_loader`'s only
    // dependency). Everything else it imports (argparse, json, os, re,
    // subprocess, sys, dataclasses, datetime, pathlib, shutil, typing) is
    // stdlib.
    const standupArgs = [
      "run",
      "--no-project",
      "--with",
      "httpx",
      "--with",
      "python-dotenv",
      "python",
      ".agents/runbooks/run-daily-standup/scripts/main.py",
      "--hours",
      String(hours),
      "--checkpoint-mode",
      checkpointMode,
    ];
    if (postToDiscord && discordWebhookUrl) {
      standupArgs.push("--post-to-discord");
    }

    logger.info("generating standup brief", { postToDiscord: postToDiscord && !!discordWebhookUrl });
    const result = await runUv(alixDir, standupArgs, {
      env: { ...sharedEnv, DAILY_STANDUP_DISCORD_WEBHOOK_URL: discordWebhookUrl },
      secrets: [ghPat, discordWebhookUrl].filter(Boolean),
    });
    logger.info("daily-standup script finished", { stdoutTail: result.stdout.slice(-2000) });

    // Original workflow also uploaded `data/EXPORTS/daily-standup/` as a CI
    // artifact for later download — trigger.dev has no direct equivalent.
    // Left un-ported; if that artifact matters, read it from `alixDir`
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
