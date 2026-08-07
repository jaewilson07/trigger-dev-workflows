import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret, cloneRepo, runUv } from "@datacrew/trigger-shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Replaces `hector-dcs/crew-rag-domo`'s `daily-scrape.yaml` GitHub Action
 * (`Daily Community Scrape`, cron `0 6 * * *`) — see `docs/watchdog-rework.md`
 * and `docs/workflow-observability-standard.md` for the conventions this
 * follows.
 *
 * Deliberately a single `schedules.task`, not a parent that
 * `triggerAndWait`s child tasks: `POST /api/v1/tasks/*\/trigger` (what a
 * single-item `triggerAndWait`/`trigger` call hits) is gated by a bot-check
 * whose Bearer-bypass allowlist does not include this project's key —
 * `infrastructure-health-report` in this same project is broken in
 * production for exactly that reason (see `docs/watchdog-rework.md`,
 * "Blocked"). `batch.triggerByTaskAndWait` is unaffected, but there is no
 * reason to introduce composition here at all: clone -> sync -> scrape ->
 * commit -> push is inherently linear, one step feeds the next, so one task
 * both matches the original Action's shape and sidesteps the gate by never
 * calling it.
 */

const execFileAsync = promisify(execFile);

const CREW_RAG_DOMO_REPO = "https://github.com/hector-dcs/crew-rag-domo.git";
const MDRAG_REPO = "https://github.com/jaewilson07/mdrag.git";
const DEFAULT_MONTHS_BACK = 1;
// Same folder the rest of this project's Infisical secrets live under.
const SECRET_PATH = "/datacrew";

type CrewRagDomoScrapePayload = {
  // `schedules.task` payloads carry a real `Date` when the scheduler invokes
  // them and a JSON string when a human triggers them from the dashboard or
  // API — `infrastructureHealthReport`'s pre-rework code assumed `Date` and
  // crashed with "toISOString is not a function" on every manual run (see
  // docs/watchdog-rework.md). Typed as both here on purpose, handled below.
  timestamp: Date | string;
  timezone: string;
  /**
   * Matches the old GitHub Action's `workflow_dispatch` input of the same
   * name. The cron invocation never sets this (Trigger.dev's schedule
   * payload has no room for custom fields), so cron runs always get
   * `DEFAULT_MONTHS_BACK`; a manual trigger from the dashboard/API can pass
   * `{ "months_back": N, ... }` to override it, same as the Action's
   * `inputs.months_back`.
   */
  months_back?: number;
};

type ScrapeOutcome = {
  status: "committed" | "no-changes";
  monthsBack: number;
  commitSha: string | null;
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

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 10,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * `cloneRepo`'s auth (a `GIT_CONFIG_GLOBAL` file scoped to the clone call) is
 * intentionally torn down the moment the clone finishes, so `git push` later
 * needs its own credential. Scoped `--local` to this one throwaway checkout
 * (deleted in `finally` below regardless of outcome) rather than global, so
 * the token never touches a config file that outlives this run.
 */
async function configurePushAuth(cwd: string, token: string): Promise<void> {
  await runGit(cwd, [
    "config",
    "--local",
    `url.https://x-access-token:${token}@github.com/.insteadOf`,
    "https://github.com/",
  ]);
}

/** `git diff --cached --quiet` exits 0 with nothing staged, non-zero when there is. */
async function hasStagedChanges(cwd: string): Promise<boolean> {
  return runGit(cwd, ["diff", "--cached", "--quiet"]).then(
    () => false,
    () => true
  );
}

async function runCrewRagDomoScrape(payload: CrewRagDomoScrapePayload): Promise<ScrapeOutcome> {
  const monthsBack = payload.months_back ?? DEFAULT_MONTHS_BACK;
  const timestampIso =
    payload.timestamp instanceof Date ? payload.timestamp.toISOString() : String(payload.timestamp);

  await safeAddTags(["crew-rag-domo", "domo", "scrape"]);
  logger.info("starting crew-rag-domo-scrape", { monthsBack, timestamp: timestampIso });

  const token = await getSecret("HECTOR_GH_PAT", { path: SECRET_PATH });

  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crew-rag-domo-scrape-"));
  // Siblings under `libraries/`, matching crew-rag-domo's own
  // `pyproject.toml` -> `[tool.uv.sources] mdrag = { path = "../../libraries/mdrag" }`.
  const librariesDir = path.join(scratchRoot, "libraries");
  const crewRagDomoDir = path.join(librariesDir, "crew-rag-domo");
  const mdragDir = path.join(librariesDir, "mdrag");

  try {
    await fs.mkdir(librariesDir, { recursive: true });

    logger.info("cloning repos", { crewRagDomoDir, mdragDir });
    await cloneRepo(CREW_RAG_DOMO_REPO, crewRagDomoDir, token);
    // NOT mdrag-vanillaforums: that path dependency was removed, see
    // hector-dcs/crew-rag-domo#6 (already fixed on main as of this task).
    await cloneRepo(MDRAG_REPO, mdragDir, token);

    logger.info("running uv sync", { cwd: crewRagDomoDir });
    await runUv(crewRagDomoDir, ["sync"]);

    logger.info("running crew-scrape-domo sync", { monthsBack });
    const scrapeResult = await runUv(crewRagDomoDir, [
      "run",
      "crew-scrape-domo",
      "sync",
      "--months-back",
      String(monthsBack),
    ]);
    logger.info("scrape command finished", { stdoutTail: scrapeResult.stdout.slice(-2000) });

    await runGit(crewRagDomoDir, ["config", "user.name", "github-actions[bot]"]);
    await runGit(crewRagDomoDir, [
      "config",
      "user.email",
      "github-actions[bot]@users.noreply.github.com",
    ]);
    await runGit(crewRagDomoDir, ["add", "EXPORTS/"]);

    // Only commit when there's actually something staged — same guard the
    // old Action had (`git diff --cached --quiet || git commit ...`). An
    // empty scrape run should not create an empty commit.
    if (!(await hasStagedChanges(crewRagDomoDir))) {
      logger.info("completed crew-rag-domo-scrape", { monthsBack, status: "no-changes" });
      return { status: "no-changes", monthsBack, commitSha: null };
    }

    const dateStamp = new Date().toISOString().slice(0, 10);
    await runGit(crewRagDomoDir, ["commit", "-m", `chore: daily scrape ${dateStamp} [skip ci]`]);

    await configurePushAuth(crewRagDomoDir, token);
    await runGit(crewRagDomoDir, ["push", "origin", "HEAD:main"]);

    const { stdout: commitSha } = await runGit(crewRagDomoDir, ["rev-parse", "HEAD"]);

    logger.info("completed crew-rag-domo-scrape", { monthsBack, status: "committed", commitSha });
    return { status: "committed", monthsBack, commitSha };
  } catch (error) {
    logger.error("failed crew-rag-domo-scrape", {
      monthsBack,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
}

export const crewRagDomoScrape = schedules.task({
  id: "crew-rag-domo-scrape",
  cron: {
    pattern: "0 6 * * *",
    environments: ["PRODUCTION"],
  },
  // Clones two repos, `uv sync`s a Python workspace, hits a live external API
  // for the actual Domo scrape, then commits and pushes — meaningfully more
  // than the other watchdog schedules do (infra-health-research's child tasks
  // shell out locally plus a couple of registry lookups, no repo clones or
  // scraping). 30 minutes is generous headroom under the project's 3600s
  // ceiling (`watchdog/trigger.config.ts`) without being unbounded.
  maxDuration: 1800,
  run: async (payload: CrewRagDomoScrapePayload) => runCrewRagDomoScrape(payload),
});
