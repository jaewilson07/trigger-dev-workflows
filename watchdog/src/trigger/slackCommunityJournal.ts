import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret, cloneRepo, runUv } from "@datacrew/trigger-shared";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Slack half of trigger-dev-workflows#144 (Weekly Slack + Domo Community
 * journal). The Domo Community half (#145) shipped first because it had no
 * dependency on mdrag's `Transcript(Document)` type; this half was blocked on
 * that type landing (mdrag#1464, ADR-0040 in the `simpleDiscordBot` umbrella
 * checkout) and on `jaewilson07/datacrew`'s capture-path replacement
 * (`slack_ingest.py`'s per-message `POST /ingest/text` -> per-channel
 * `POST /ingest/transcript` upsert) that dependency required — both landed
 * (`jaewilson07/datacrew#537`) before this task was written.
 *
 * `watchdog`, not `executive-assistant`, per ADR-001 — identical reasoning to
 * `domoCommunityJournal.ts`: a cron pipeline keeping mdrag's `datacrew`
 * collection in sync, no human is a first-class participant in the run.
 *
 * Thin clone-and-invoke wrapper, per ADR-054 — all the real logic (Slack
 * fetch, single-pass LLM classification, redaction, mdrag emit) lives in
 * `datacrew`'s own runbook
 * (`.agents/runbooks/daily-slack-updates/slack-community-journal/scripts/main.py`),
 * sharing its taxonomy/redaction/mdrag-client/windowing modules with
 * `domoCommunityJournal.ts`'s orchestrator via `datacrew`'s own
 * `_shared/scripts/` (not duplicated here) — this task only clones, invokes
 * `uv run`, and surfaces the result. Same shape as `domoCommunityJournal.ts`.
 *
 * **Deliberately does NOT wire Graphiti/`add_episode`** — unlike
 * `domoCommunityJournal.ts`, the Slack synthesis pipeline only calls
 * `create_annotation` (trigger-dev-workflows#144's decision: no Slack-side
 * Graphiti entity types have been designed, and the Domo Community wiring is
 * explicitly not to be duplicated for Slack).
 *
 * Deliberately a single `schedules.task`, not a parent that `triggerAndWait`s
 * child tasks — same reasoning as `domoCommunityJournal.ts`: fetch -> classify
 * -> redact -> emit is one straight line.
 *
 * ## Scheduling note
 *
 * Runs Monday 08:00 UTC — one hour after `domoCommunityJournal.ts`'s 07:00 UTC
 * slot, so the two weekly journal runs don't contend for the same worker at
 * the exact same minute (same spacing convention `infra-health-research`'s
 * 06:00 daily and `crew-rag-domo-scrape`'s 06:00 daily already use relative to
 * each other).
 *
 * ## Idempotency note
 *
 * `--as-of timestampIso` below is load-bearing the same way it is for
 * `domoCommunityJournal.ts`: `main.py` truncates it to a UTC-midnight
 * boundary and derives the whole window (hence the mdrag idempotency key,
 * seeded with `source="slack"` so it never collides with the Domo Community
 * pipeline's own key for the identical window string) from it, so a
 * Trigger.dev retry of THIS run's payload upserts the same Annotation instead
 * of minting a new one.
 */

const DATACREW_REPO_URL = "https://github.com/jaewilson07/datacrew.git";
const ORCHESTRATOR_RELATIVE_PATH =
  ".agents/runbooks/daily-slack-updates/slack-community-journal/scripts/main.py";

// Same folder the rest of this project's Infisical secrets live under
// (crewRagDomoScrape.ts's HECTOR_GH_PAT/DATACREW_API_TOKEN,
// domoCommunityJournal.ts's own DATACREW_API_TOKEN, domoDocsReport.ts's SHA
// cache).
const SECRET_PATH = "/datacrew";

const DEFAULT_DAYS = 7;
const DEFAULT_GROUP_ID = "datacrew";

type SlackCommunityJournalPayload = {
  // `schedules.task` payloads carry a real `Date` when the scheduler invokes
  // them and a JSON string when a human triggers them manually — same footgun
  // `domoCommunityJournal.ts`/`crewRagDomoScrape.ts` document.
  timestamp: Date | string;
  timezone: string;
  /** Trailing window size in days. Cron runs always get DEFAULT_DAYS; a manual
   * trigger can override. */
  days?: number;
  /**
   * What counts as "interesting" for this classification pass — threaded
   * straight through to the orchestrator's `--interesting` flag. See
   * `domoCommunityJournal.ts`'s identical field for the pluggable-parameter
   * rationale (trigger-dev-workflows#144).
   */
  interesting?: string;
  /** Still fetches live from Slack; skips the LLM call and mdrag writes. */
  dry_run?: boolean;
};

type SlackCommunityJournalOutcome = {
  status: "emitted" | "no-posts" | "no-qualifying-items" | "dry-run";
  days: number;
  itemCount: number;
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

async function runSlackCommunityJournal(
  payload: SlackCommunityJournalPayload
): Promise<SlackCommunityJournalOutcome> {
  const days = payload.days ?? DEFAULT_DAYS;
  const dryRun = payload.dry_run ?? false;
  const timestampIso =
    payload.timestamp instanceof Date ? payload.timestamp.toISOString() : String(payload.timestamp);

  await safeAddTags(["slack-community-journal", "slack", "mdrag"]);
  logger.info("starting slack-community-journal", { days, dryRun, timestamp: timestampIso });

  // `datacrew` is jaewilson07-owned and private — same token
  // domoCommunityJournal.ts/domoDocsReport.ts use to clone it.
  const jaewilson07Token = await getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false });

  // Slack Web API read auth (`conversations.history`) — the same bot token
  // datacrew's slackbot/ runtime already uses (SLACK_BOT_TOKEN), scoped with
  // channels:history/groups:history already granted per the design doc (no
  // new OAuth scopes needed for this pipeline).
  const slackBotToken = await getSecret("SLACK_BOT_TOKEN", { path: SECRET_PATH });

  // Classification LLM credential. Root of the Infisical tree, same as
  // domoCommunityJournal.ts's identical lookup.
  const anthropicApiKey = dryRun ? "" : await getSecret("ANTHROPIC_API_KEY", { path: "/", recursive: false });

  // mdrag write auth — the SAME DATACREW_API_TOKEN domoCommunityJournal.ts/
  // crewRagDomoScrape.ts already depend on, under this project's existing
  // /datacrew Infisical path.
  const datacrewApiToken = dryRun ? "" : await getSecret("DATACREW_API_TOKEN", { path: SECRET_PATH });

  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-community-journal-"));
  const dataCrewDir = path.join(scratchRoot, "datacrew");

  try {
    logger.info("cloning datacrew", { dataCrewDir });
    await cloneRepo(DATACREW_REPO_URL, dataCrewDir, jaewilson07Token);

    const scriptPath = path.join(dataCrewDir, ORCHESTRATOR_RELATIVE_PATH);
    const args = [
      "run",
      "--no-project",
      "--with",
      "httpx",
      "--with",
      "slack_sdk",
      "--with",
      "pyyaml",
      scriptPath,
      "--days",
      String(days),
      "--group-id",
      DEFAULT_GROUP_ID,
      // Fixed across a retry of THIS run — see this file's module docstring
      // ("Idempotency note") for the full mechanism.
      "--as-of",
      timestampIso,
      ...(payload.interesting ? ["--interesting", payload.interesting] : []),
      ...(dryRun ? ["--dry-run"] : []),
    ];

    logger.info("running slack-community-journal orchestrator", { scriptPath, days, dryRun });
    // Secrets travel via env, not argv — same reasoning
    // domoCommunityJournal.ts/crewRagDomoScrape.ts document.
    const result = await runUv(dataCrewDir, args, {
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: slackBotToken,
        ...(anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
        ...(datacrewApiToken ? { DATACREW_API_TOKEN: datacrewApiToken } : {}),
      },
      secrets: [slackBotToken, anthropicApiKey, datacrewApiToken].filter(Boolean),
    });
    logger.info("slack-community-journal orchestrator finished", { stdoutTail: result.stdout.slice(-2000) });

    const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as {
      status?: string;
      item_count?: number;
    };
    const status = (parsed.status as SlackCommunityJournalOutcome["status"]) ?? "no-posts";
    const itemCount = parsed.item_count ?? 0;

    logger.info("completed slack-community-journal", { status, itemCount, days });
    return { status, days, itemCount };
  } catch (error) {
    logger.error("failed slack-community-journal", {
      days,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
}

export const slackCommunityJournal = schedules.task({
  id: "slack-community-journal",
  cron: {
    // Weekly — trigger-dev-workflows#144's decision ("Cadence: weekly", for
    // both Slack and Domo Community). Monday 08:00 UTC — one hour after
    // domoCommunityJournal.ts's 07:00 UTC slot (see module docstring).
    pattern: "0 8 * * 1",
    environments: ["PRODUCTION"],
  },
  // Clones datacrew, `uv run --no-project`s httpx+slack_sdk+pyyaml, which then
  // does a paginated Slack Web API fetch per channel, one LLM classification
  // call, and (unless dry_run) one mdrag REST call. Comparable in shape to
  // domo-community-journal's 900s budget.
  maxDuration: 900,
  run: async (payload: SlackCommunityJournalPayload) => runSlackCommunityJournal(payload),
});
