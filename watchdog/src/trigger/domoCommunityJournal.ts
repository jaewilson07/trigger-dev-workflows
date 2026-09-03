import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret, cloneRepo, runUv } from "@datacrew/trigger-shared";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Domo Community half of trigger-dev-workflows#144 (Weekly Slack + Domo
 * Community journal). The Slack half is deliberately NOT built here — it
 * depends on mdrag's `Transcript(Document)` type (mdrag#1464), which had not
 * landed as of this task's creation; the Domo Community half has no such
 * dependency (see `.agents/plans/datacrew-slack-transcript-ingestion.md` in
 * `jaewilson07/simpleDiscordBot`, PR #740).
 *
 * `watchdog`, not `executive-assistant`, per ADR-001: same reasoning as
 * `crewRagDomoScrape.ts`/`domoDocsReport.ts` — a cron pipeline that keeps
 * mdrag's `datacrew` collection in sync with an external forum, no human is a
 * first-class participant in the run (the audience is the mdrag Annotation +
 * Graphiti graph, not a Slack channel or a person watching this specific
 * task). This IS the `crew-rag-domo-scrape` precedent ADR-001 itself cites as
 * the canonical `watchdog` example, not an edge case argued into it.
 *
 * Thin clone-and-invoke wrapper, per ADR-054 — all the real logic (fetch,
 * single-pass LLM classification, redaction, dual mdrag emit) lives in
 * `datacrew`'s own runbook
 * (`.agents/runbooks/daily-slack-updates/domo-community-journal/scripts/main.py`),
 * reusing `generate-community-forums-summary`'s `VanillaPost` extraction as its
 * deterministic layer — this task only clones, invokes `uv run`, and surfaces
 * the result. Same shape as `domoDocsReport.ts` (clone `datacrew`, `uv run
 * --no-project` an ad-hoc dependency set, no lockfile/venv reuse).
 *
 * Deliberately a single `schedules.task`, not a parent that `triggerAndWait`s
 * child tasks — same Turnstile-gate-avoidance reasoning documented in
 * `crewRagDomoScrape.ts`, and the same "inherently linear, no benefit to
 * composition" reasoning `domoDocsReport.ts` gives: fetch -> classify ->
 * redact -> emit is one straight line, one step feeding the next.
 *
 * ## Ontology wiring note
 *
 * `DOMO_COMMUNITY_ENTITY_TYPES`/`WorkaroundEntity`/`BugOrIssueEntity`
 * (`libraries/mdrag/src/integrations/graphiti/models.py`) were already
 * *registered* server-side before this task (`ontology="domo_community"` in
 * `add_episode`'s `_ONTOLOGIES` map, `graph/handlers.py`) — grep confirmed
 * that registration exists, so "zero callers" would overstate it. What was
 * actually missing, confirmed by the same grep, was any caller anywhere in
 * mdrag or datacrew actually *invoking* `add_episode(ontology="domo_community")`
 * end to end. This task is that first real invocation.
 *
 * ## Idempotency note (2026-09-03 fix)
 *
 * `--as-of timestampIso` below is load-bearing, not just an audit trail:
 * `main.py` truncates it to a UTC-midnight boundary and derives the whole
 * window (hence the mdrag idempotency key) from it, so a Trigger.dev retry of
 * THIS run's payload (fixed across retry attempts) upserts the same
 * Annotation instead of minting a new one, and skips a duplicate
 * `add_episode` call (which has no dedup of its own — see `main.py`'s module
 * docstring for the full mechanism and why a local state file inside this
 * container would not work).
 */

const DATACREW_REPO_URL = "https://github.com/jaewilson07/datacrew.git";
const ORCHESTRATOR_RELATIVE_PATH =
  ".agents/runbooks/daily-slack-updates/domo-community-journal/scripts/main.py";

// Same folder the rest of this project's Infisical secrets live under
// (crewRagDomoScrape.ts's HECTOR_GH_PAT/DATACREW_API_TOKEN, domoDocsReport.ts's
// SHA cache).
const SECRET_PATH = "/datacrew";

const DEFAULT_DAYS = 7;
const DEFAULT_GROUP_ID = "datacrew";

type DomoCommunityJournalPayload = {
  // `schedules.task` payloads carry a real `Date` when the scheduler invokes
  // them and a JSON string when a human triggers them manually — same footgun
  // `crewRagDomoScrape.ts`/`domoDocsReport.ts`/`infraHealthReport.ts` document.
  timestamp: Date | string;
  timezone: string;
  /** Trailing window size in days. Cron runs always get DEFAULT_DAYS; a manual
   * trigger can override. */
  days?: number;
  /**
   * What counts as "interesting" for this classification pass — threaded
   * straight through to the orchestrator's `--interesting` flag. A pluggable
   * per-user/per-use-case parameter (trigger-dev-workflows#144's explicit
   * decision), not a hardcoded prompt constant: this payload field is only
   * wired to ONE default value today (the orchestrator script's own
   * `classify.DEFAULT_INTERESTING`, applied when this field is omitted), but
   * the parameter itself exists end to end, from this task's payload down to
   * the LLM prompt.
   */
  interesting?: string;
  /** Skip mdrag writes (create_annotation/add_episode); still fetches + classifies + redacts. */
  dry_run?: boolean;
};

type DomoCommunityJournalOutcome = {
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

async function runDomoCommunityJournal(
  payload: DomoCommunityJournalPayload
): Promise<DomoCommunityJournalOutcome> {
  const days = payload.days ?? DEFAULT_DAYS;
  const dryRun = payload.dry_run ?? false;
  const timestampIso =
    payload.timestamp instanceof Date ? payload.timestamp.toISOString() : String(payload.timestamp);

  await safeAddTags(["domo-community-journal", "domo", "mdrag"]);
  logger.info("starting domo-community-journal", { days, dryRun, timestamp: timestampIso });

  // `datacrew` is jaewilson07-owned and private — same token domoDocsReport.ts
  // uses to clone it (HECTOR_GH_PAT, the hector-dcs bot account, cannot see it).
  const jaewilson07Token = await getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false });

  // Classification LLM credential. Root of the Infisical tree (not /datacrew) —
  // not scoped to any single app, same reasoning HECTOR_GH_PAT/JAEWILSON07_GH_PAT
  // use "/" above.
  const anthropicApiKey = dryRun ? "" : await getSecret("ANTHROPIC_API_KEY", { path: "/", recursive: false });

  // mdrag write auth — the SAME DATACREW_API_TOKEN crewRagDomoScrape.ts already
  // depends on for its own mdrag ingest call, under this project's existing
  // /datacrew Infisical path.
  const datacrewApiToken = dryRun ? "" : await getSecret("DATACREW_API_TOKEN", { path: SECRET_PATH });

  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "domo-community-journal-"));
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
      scriptPath,
      "--days",
      String(days),
      "--group-id",
      DEFAULT_GROUP_ID,
      // Fixed across a retry of THIS run (Trigger.dev holds a run's payload
      // constant across its own retry attempts) — main.py truncates it to a
      // UTC-midnight boundary and uses it for the idempotency key, so a retry
      // upserts create_annotation's Annotation in place and skips a duplicate
      // add_episode call, instead of minting a second Annotation/episode pair
      // every attempt. See main.py's module docstring ("Idempotency (2026-09-03
      // fix)") for the full mechanism, including why a local state file inside
      // this container would NOT work (fresh filesystem per invocation).
      "--as-of",
      timestampIso,
      ...(payload.interesting ? ["--interesting", payload.interesting] : []),
      ...(dryRun ? ["--dry-run"] : []),
    ];

    logger.info("running domo-community-journal orchestrator", { scriptPath, days, dryRun });
    // Secrets travel via env, not argv — execFile's failure message echoes the
    // full argv it was called with (same reasoning crewRagDomoScrape.ts's
    // runGit/domoDocsReport.ts's slackBotToken passing document). `secrets` is
    // belt-and-suspenders redaction in case the script itself ever echoes one
    // to stdout/stderr.
    const result = await runUv(dataCrewDir, args, {
      env: {
        ...process.env,
        ...(anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
        ...(datacrewApiToken ? { DATACREW_API_TOKEN: datacrewApiToken } : {}),
      },
      secrets: [anthropicApiKey, datacrewApiToken].filter(Boolean),
    });
    logger.info("domo-community-journal orchestrator finished", { stdoutTail: result.stdout.slice(-2000) });

    const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as {
      status?: string;
      item_count?: number;
    };
    const status = (parsed.status as DomoCommunityJournalOutcome["status"]) ?? "no-posts";
    const itemCount = parsed.item_count ?? 0;

    logger.info("completed domo-community-journal", { status, itemCount, days });
    return { status, days, itemCount };
  } catch (error) {
    logger.error("failed domo-community-journal", {
      days,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
}

export const domoCommunityJournal = schedules.task({
  id: "domo-community-journal",
  cron: {
    // Weekly — trigger-dev-workflows#144's decision (confirmed in the design
    // doc, "Cadence: weekly", for both Slack and Domo Community). Monday
    // 07:00 UTC, ahead of infra-health-research's 06:00 daily and
    // crew-rag-domo-scrape's 06:00 daily so this doesn't contend with either
    // on the same worker.
    pattern: "0 7 * * 1",
    environments: ["PRODUCTION"],
  },
  // Clones datacrew, `uv run --no-project`s a single dependency (httpx), which
  // then does two paginated forum API fetch passes, one LLM classification
  // call, and (unless dry_run) two mdrag calls (REST + MCP). Comparable in
  // shape to domo-docs-report's 900s budget; the LLM round-trip is the only
  // meaningfully slower step, still well under this ceiling for a week's
  // worth of forum posts.
  maxDuration: 900,
  run: async (payload: DomoCommunityJournalPayload) => runDomoCommunityJournal(payload),
});
