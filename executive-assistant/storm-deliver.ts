import { batch, task, logger } from "@trigger.dev/sdk";
import { prepareReport } from "./tasks/generate-briefing.js";
import { outputSlackBriefing } from "./tasks/output-slack-briefing.js";
import { outputSlackMd } from "./tasks/output-slack-md.js";
import { outputGoogleDoc } from "./tasks/output-google-doc.js";
import { outputMdragIngest } from "./tasks/output-mdrag-ingest.js";
import { outputMdragIngestSources } from "./tasks/output-mdrag-ingest-sources.js";
import { outputNotion } from "./tasks/output-notion.js";
import { outputFailed } from "./lib/storm-types.js";
import type {
  OutputDestination,
  OutputResult,
  SourceIngestResult,
  StormBriefingWithMarkdown,
  StormResearch,
} from "./lib/storm-types.js";

/**
 * The OUTPUT half of STORM: render once, then fan out to every destination in
 * parallel.
 *
 * Takes a `StormResearch` and nothing else, so it is reusable by anything that
 * can produce that shape — and, more to the point, re-runnable on its own. A
 * STORM run costs hours; re-delivering one to a destination that was
 * misconfigured at the time now costs one trigger.
 *
 * ## Three defects this fixes, all of which followed from the missing seam
 *
 * 1. THE FAN-OUT WAS SEQUENTIAL. Step 7 used to be a `for` loop of
 *    `await …triggerAndWait()`, so a slow Slack file upload delayed the mdrag
 *    ingest behind it. It is now one `batch.triggerByTaskAndWait`, which is the
 *    documented way to run DIFFERENT tasks concurrently and wait for all of
 *    them. (`Promise.all` around `triggerAndWait` is unsupported, and it would
 *    not isolate failures — the batch reports a thrown destination as
 *    `runs[i].ok === false` rather than rejecting the whole call.)
 *
 * 2. `skipped` WAS ENCODED AS FAILURE. `skipped()` returned
 *    `{ success: false, error: "skipped — …" }`, so "no Slack channel was
 *    configured" read identically to "Slack returned a 500". See `OutputStatus`
 *    in `lib/storm-types.ts`.
 *
 * 3. THE SEAM WAS RENDERED OUTPUT. `prepare-report` pre-rendered html +
 *    markdown + summary, so a destination needing a different shape meant
 *    editing `prepare-report`. It now runs HERE, behind the seam, once — the
 *    briefing is still what the four destinations receive, but the boundary
 *    between the halves is `StormResearch`, so a fifth destination with a fifth
 *    format is a new task instead.
 *
 * ## Why the batch is always six entries
 *
 * `triggerByTaskAndWait` types its result positionally, so a conditionally
 * shortened array loses per-destination types. Every destination is always
 * triggered and an unconfigured or unrequested one returns `skipped` — which
 * also means the run history records exactly which destinations were live and
 * why the others were not. Six no-op runs is a cheap price for that.
 *
 * Adding Notion as the fifth cost exactly one entry here and one task file,
 * which is the payoff the seam was built for: before the split it would have
 * meant editing the 376-line research-and-delivery monolith. `mdrag_sources`
 * is the sixth, gated by the exact same "mdrag" toggle as `output-mdrag-ingest`
 * rather than its own entry in `OutputDestination` — see
 * jaewilson07/trigger-dev-workflows#50.
 */

export type StormDeliverPayload = {
  research: StormResearch;
  /**
   * Which destinations to attempt. The others still appear in the result as
   * `skipped`, with "not requested" as the reason. Default:
   * slack_briefing + slack_md + mdrag (Google Doc needs an explicit identity —
   * see `googleOwnerEmail`).
   */
  outputs?: OutputDestination[];
  /** Slack channel to post to. Defaults to a DM to `slackUserId`. */
  slackChannel?: string;
  /** Slack user ID — DM target, and the auth-service key for the Google Doc. */
  slackUserId?: string;
  /**
   * The canonical Google identity to publish the doc as. PREFERRED over
   * `slackUserId`: the auth service keys `google_tokens` by `owner_email` and
   * rejects platform-prefixed ids (infra-bonker#409), so a raw Slack user id
   * 400s there. See `tasks/output-google-doc.ts`.
   */
  googleOwnerEmail?: string;
  /** Overwrite a specific doc in place instead of creating a new one. */
  googleDocumentId?: string;
  /**
   * mdrag collection to ingest into. Defaults to the requesting caller's own
   * personal collection (resolved server-side from the DATACREW_API_TOKEN
   * identity) when omitted.
   */
  mdragCollectionId?: string;
  /** Notion database to upsert the briefing into. Defaults to NOTION_DATABASE_ID. */
  notionDatabaseId?: string;
};

export type StormDeliverResult = {
  topic: string;
  briefing: StormBriefingWithMarkdown;
  outputs: OutputResult[];
  deliveredCount: number;
  skippedCount: number;
  failedCount: number;
  /**
   * Result of ingesting every unique cited source URL into mdrag — runs
   * alongside `output-mdrag-ingest` under the same "mdrag" output toggle.
   * `skipped` (not attempted) when "mdrag" wasn't requested.
   */
  sourceIngest: SourceIngestResult;
};

/**
 * Notion is in the defaults for the same reason mdrag is: it is addressed
 * entirely by environment (`NOTION_TOKEN` + `NOTION_DATABASE_ID`) and reports
 * `skipped` when that is absent, so listing it costs nothing on a deployment
 * that has no Notion. `google_doc` stays out because it needs an explicit
 * identity that no environment default can supply — see `googleOwnerEmail`.
 */
const DEFAULT_OUTPUTS: OutputDestination[] = ["slack_briefing", "slack_md", "mdrag", "notion"];

/** Trigger.dev surfaces a failed child's error as an unknown-ish object. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

/**
 * A destination task returning its own `OutputResult` is the normal case — all
 * four catch their own errors. This covers the other one: the task itself died
 * (OOM, timeout, a throw outside its try block), which the batch reports as
 * `ok: false`. Recorded as `failed` rather than allowed to sink its siblings.
 */
function toResult(
  destination: OutputDestination,
  run: { ok: boolean; output?: unknown; error?: unknown }
): OutputResult {
  if (run.ok) return run.output as OutputResult;
  return outputFailed(destination, errorMessage(run.error));
}

/**
 * Same "the task itself died" case as `toResult`, but for
 * `output-mdrag-ingest-sources`, whose aggregate result is a
 * `SourceIngestResult`, not an `OutputResult` — see `lib/storm-types.ts`.
 */
function toSourceIngestResult(run: {
  ok: boolean;
  output?: unknown;
  error?: unknown;
}): SourceIngestResult {
  if (run.ok) return run.output as SourceIngestResult;
  return {
    status: "failed",
    success: false,
    error: errorMessage(run.error),
    counts: { total: 0, succeeded: 0, failed: 0 },
  };
}

export const stormDeliver = task({
  id: "storm-deliver",
  retry: { maxAttempts: 1 },
  run: async (payload: StormDeliverPayload): Promise<StormDeliverResult> => {
    const { research } = payload;
    const requested = new Set(payload.outputs ?? DEFAULT_OUTPUTS);
    const slackChannel =
      payload.slackChannel ?? (payload.slackUserId ? `user:${payload.slackUserId}` : "");

    logger.info("starting storm-deliver", { topic: research.topic, outputs: [...requested] });

    // ── Render once, behind the seam ──────────────────────────
    const briefing: StormBriefingWithMarkdown = await prepareReport
      .triggerAndWait({
        topic: research.topic,
        report: research.report,
        verification: research.verification,
        perspectiveCount: research.perspectiveCount,
        contradictionCount: research.contradictionCount,
      })
      .unwrap();

    logger.info("storm-deliver: delivering outputs", {
      topic: research.topic,
      outputs: [...requested],
      slackChannel: slackChannel || "(none)",
    });

    // ── Fan out, in parallel ──────────────────────────────────
    //
    // `enabled` carries both "the caller didn't ask for this destination" and
    // "this destination has no addressing", so each task reports its own
    // `skipped` reason rather than this orchestrator guessing on its behalf.
    const {
      runs: [briefingRun, mdRun, docRun, mdragRun, mdragSourcesRun, notionRun],
    } = await batch.triggerByTaskAndWait([
      {
        task: outputSlackBriefing,
        payload: {
          briefing,
          slackChannel,
          enabled: requested.has("slack_briefing"),
        },
      },
      {
        task: outputSlackMd,
        payload: {
          briefing,
          slackChannel,
          enabled: requested.has("slack_md"),
        },
      },
      {
        task: outputGoogleDoc,
        payload: {
          briefing,
          enabled: requested.has("google_doc"),
          ...(payload.slackUserId ? { slackUserId: payload.slackUserId } : {}),
          // `googleOwnerEmail`/`googleDocumentId` are accepted on this task's
          // own payload (see StormDeliverPayload) but output-google-doc.ts
          // doesn't implement either yet — it only knows slackUserId. Not
          // wired through here so this doesn't silently claim support that
          // doesn't exist; see jaewilson07/trigger-dev-workflows#26.
        },
      },
      {
        task: outputMdragIngest,
        payload: {
          briefing,
          topic: research.topic,
          enabled: requested.has("mdrag"),
          // Omitted by default — mdrag resolves the ingest to the caller's
          // own personal collection from the DATACREW_API_TOKEN identity.
          // Only forwarded when the caller explicitly requests a different
          // destination. See jaewilson07/mdrag#1017, #48 (was #26).
          ...(payload.mdragCollectionId ? { mdragCollectionId: payload.mdragCollectionId } : {}),
        },
      },
      {
        // Sibling step, same "mdrag" toggle as output-mdrag-ingest above:
        // every unique cited source URL also gets ingested, not just the
        // composed report. See jaewilson07/trigger-dev-workflows#50.
        task: outputMdragIngestSources,
        payload: {
          findings: research.findings,
          topic: research.topic,
          enabled: requested.has("mdrag"),
          ...(payload.mdragCollectionId ? { mdragCollectionId: payload.mdragCollectionId } : {}),
        },
      },
      {
        task: outputNotion,
        payload: {
          briefing,
          enabled: requested.has("notion"),
          ...(payload.notionDatabaseId ? { databaseId: payload.notionDatabaseId } : {}),
        },
      },
    ]);

    const outputs: OutputResult[] = [
      toResult("slack_briefing", briefingRun),
      toResult("slack_md", mdRun),
      toResult("google_doc", docRun),
      toResult("mdrag", mdragRun),
      toResult("notion", notionRun),
    ];
    const sourceIngest = toSourceIngestResult(mdragSourcesRun);

    const result: StormDeliverResult = {
      topic: research.topic,
      briefing,
      outputs,
      deliveredCount: outputs.filter((o) => o.status === "delivered").length,
      skippedCount: outputs.filter((o) => o.status === "skipped").length,
      failedCount: outputs.filter((o) => o.status === "failed").length,
      sourceIngest,
    };

    // A failed destination does NOT fail this task — the others already
    // delivered, and throwing would retry them too.
    for (const output of outputs) {
      if (output.status === "failed") {
        logger.error("storm-deliver: destination failed", {
          destination: output.destination,
          error: output.error,
        });
      }
    }
    if (sourceIngest.status === "failed") {
      logger.error("storm-deliver: source ingest failed", {
        error: sourceIngest.error,
        counts: sourceIngest.counts,
      });
    }
    logger.info("storm-deliver: complete", {
      topic: research.topic,
      delivered: result.deliveredCount,
      skipped: result.skippedCount,
      failed: result.failedCount,
      sourceIngest: sourceIngest.counts,
    });

    return result;
  },
});
