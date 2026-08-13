import { task, logger, metadata } from "@trigger.dev/sdk";
import { discoverPerspectives } from "./tasks/discover-perspectives.js";
import { conductInterview } from "./tasks/conduct-interview.js";
import { mapContradictions } from "./tasks/map-contradictions.js";
import { synthesizeReport } from "./tasks/synthesize-report.js";
import { verifySources } from "./tasks/verify-sources.js";
import { prepareReport } from "./tasks/generate-briefing.js";
import { outputSlackBriefing } from "./tasks/output-slack-briefing.js";
import { outputSlackMd } from "./tasks/output-slack-md.js";
import { outputGoogleDoc } from "./tasks/output-google-doc.js";
import { outputMdragIngest } from "./tasks/output-mdrag-ingest.js";
import { outputMdragIngestSources } from "./tasks/output-mdrag-ingest-sources.js";
import { outputFailed, outputSkipped, sourceIngestSkipped } from "./lib/storm-types.js";
import { resolveOrCreateConversation } from "./lib/mdrag-conversation-resolver.js";
import type {
  Perspective,
  InterviewResult,
  ContradictionMap,
  SynthesizedReport,
  VerificationReport,
  StormBriefingWithMarkdown,
  OutputDestination,
  OutputResult,
  SourceIngestResult,
  StormRunProgress,
} from "./lib/storm-types.js";

/**
 * storm-research-full-run — the parent orchestrator for the STORM workflow.
 *
 * STORM (Synthesis of Topic Outlines through Retrieval and Multi-perspective
 * question asking) — Stanford OVAL lab method, implemented as a trigger.dev
 * workflow backed by Letta Cloud agents.
 *
 * ## Pipeline (7 stages)
 *
 * 1. discover-perspectives → generates 5+ expert lenses for the topic
 * 2. conduct-interview (×N parallel via batchTriggerAndWait) → each perspective
 *    researches the topic using web_search + fetch_webpage tools
 * 3. map-contradictions → analyzes findings for disagreements and gaps
 * 4. synthesize-report → groups by theme, writes sections with citations
 * 5. verify-sources (×N parallel) → adversarial fact-checking against primary sources
 * 6. prepare-report → packages the report as HTML + Markdown + a summary
 * 7. output-* (fan-out) → delivers the report to the requested destinations
 *
 * ## Composable outputs
 *
 * Step 6 only *builds* the report; it delivers nothing. Delivery is a set of
 * interchangeable `output-*` tasks, each taking the same
 * `StormBriefingWithMarkdown` and returning an `OutputResult`:
 *
 *   slack_briefing → output-slack-briefing (summary text to a channel/DM)
 *   slack_md       → output-slack-md       (full Markdown as a .md file)
 *   google_doc     → output-google-doc     (STUB — not yet implemented)
 *   mdrag          → output-mdrag-ingest   (Markdown into the mdrag wiki)
 *
 * `mdrag` also always triggers `output-mdrag-ingest-sources` as a sibling
 * step — every unique, non-empty source URL cited across the run's findings
 * gets ingested too, not just the composed report. Not a separate entry in
 * `outputs`: it's gated by the same "mdrag" toggle, reported separately as
 * `sourceIngest` on the result. See jaewilson07/trigger-dev-workflows#50.
 *
 * Pick destinations with `outputs`. An output that fails is recorded in the
 * result and does not fail the run — adding a destination can't break the
 * others.
 *
 * ## Evaluator-Optimizer Loop (the "agentic" part)
 *
 * After verification (step 5), if any claims failed (corrected or demoted),
 * the workflow loops back to synthesize-report (step 4) with the corrections.
 * This continues until all claims are confirmed OR maxRevisionRounds is hit.
 *
 * This is the trigger.dev evaluator-optimizer pattern:
 * - Evaluator = verify-sources (checks if claims are grounded)
 * - Optimizer = synthesize-report (revises based on feedback)
 * - Loop = recursive triggerAndWait with feedback until quality threshold
 *
 * ## Checkpoint-Resume
 *
 * trigger.dev v4 serializes the call stack after every `await`. If the runner
 * crashes or restarts mid-workflow, it resumes from the last checkpoint —
 * no lost progress. This is what makes hours-long research loops practical.
 *
 * ## Usage
 *
 * Trigger from the dashboard's Test tab on `storm-research-full-run`:
 *   {"topic": "The impact of AI agents on enterprise data engineering"}
 *
 * Optional fields:
 *   customPerspectives: ["security", "legal", "ethics"] — add custom lenses
 *   maxRevisionRounds: 2 — max verify→revise loops (default 2)
 *   slackChannel: "user:U08L4B485B4" — where to post the briefing
 *   slackUserId: "U08L4B485B4" — DM target + Google Doc share target
 *   outputs: ["slack_briefing", "slack_md", "mdrag"] — delivery destinations
 *   userEmail: "jae@datacrew.space" — identity for the resolved mdrag
 *     Conversation (#51); defaults to MORNING_BRIEF_USER_EMAIL, this repo's
 *     established single-operator identity default (see letta-fallback.ts,
 *     conversation-agent.ts, brief-research.ts)
 */

export type StormResearchPayload = {
  topic: string;
  /** Custom perspective lenses in addition to the 5 defaults. */
  customPerspectives?: string[];
  /** Max verify→revise loops. Default 2. */
  maxRevisionRounds?: number;
  /** Slack channel to post the briefing to. Defaults to a DM to slackUserId. */
  slackChannel?: string;
  /** Slack user ID — used to DM the user and to share the Google Doc with them. */
  slackUserId?: string;
  /** Where to deliver the finished report. Default: slack_briefing + slack_md + mdrag. */
  outputs?: OutputDestination[];
  /**
   * Identity of the triggering user, for resolving/creating this run's own
   * mdrag Conversation (#51) — the report-synthesis step's Letta agent
   * shifts from the fixed shared research agent to this conversation's own
   * agent. Defaults to MORNING_BRIEF_USER_EMAIL, matching every other
   * single-operator identity default in this codebase.
   */
  userEmail?: string;
};

export type StormResearchResult = StormBriefingWithMarkdown & {
  run_id: string;
  started_at: string;
  duration_ms: number;
  revision_rounds: number;
  /** One entry per requested output destination. */
  outputs: OutputResult[];
  /**
   * Result of ingesting every unique cited source URL into mdrag — runs
   * alongside `output-mdrag-ingest` under the same "mdrag" output toggle.
   * `skipped` (not attempted) when "mdrag" wasn't in `outputs`.
   */
  sourceIngest: SourceIngestResult;
  /** The mdrag Conversation report synthesis ran inside of (#51). */
  mdrag_conversation_id: string;
  mdrag_conversation_external_ref: string;
  mdrag_conversation_source: "resolved" | "created";
};

const DEFAULT_MAX_REVISIONS = 2;
const VERIFICATION_SHARDS = 6;
const DEFAULT_OUTPUTS: OutputDestination[] = ["slack_briefing", "slack_md", "mdrag"];

const STEP_LABELS = [
  "Discover Perspectives",
  "Conduct Interviews",
  "Map Contradictions",
  "Synthesize Report",
  "Verify Sources",
  "Prepare Report",
  "Deliver Outputs",
];

export const stormResearchFullRun = task({
  id: "storm-research-full-run",
  retry: { maxAttempts: 1 }, // child tasks retry independently
  run: async (payload: StormResearchPayload, { ctx }): Promise<StormResearchResult> => {
    logger.info("starting storm-research-full-run");

    const topic = payload.topic?.trim();
    if (!topic) {
      throw new Error("topic is required");
    }

    const maxRevisions = payload.maxRevisionRounds ?? DEFAULT_MAX_REVISIONS;
    const requestedOutputs = payload.outputs ?? DEFAULT_OUTPUTS;
    const slackChannel =
      payload.slackChannel ?? (payload.slackUserId ? `user:${payload.slackUserId}` : "");
    const runStartedAt = ctx.run.startedAt;

    // ── Resolve this run's mdrag Conversation (#51) ────────────
    //
    // Minted ONCE per run (not per revision-loop attempt below) so every
    // synthesis call within this run — including revisions — lands in the
    // SAME conversation. Report synthesis then messages this conversation's
    // own Letta agent instead of the fixed shared EMMABOT_AGENT_ID that
    // perspectives/interviews still use (those stay untouched, unchanged,
    // still parallel — out of scope for #51).
    const requestingUserEmail =
      payload.userEmail?.trim() || process.env.MORNING_BRIEF_USER_EMAIL || undefined;
    const conversationExternalRef = `storm-research:${ctx.run.id}`;

    logger.info("storm-research: resolving mdrag conversation for report synthesis", {
      externalRef: conversationExternalRef,
      hasUserEmail: Boolean(requestingUserEmail),
    });

    const resolvedConversation = await resolveOrCreateConversation({
      userId: payload.slackUserId ?? "storm-research",
      userEmail: requestingUserEmail,
      title: `STORM research: ${topic}`.slice(0, 200),
      externalRef: conversationExternalRef,
    });

    if (!resolvedConversation.agentId) {
      throw new Error(
        `mdrag conversation ${resolvedConversation.conversationId} (external_ref=${conversationExternalRef}) ` +
          `has no agent_id — cannot synthesize the report`
      );
    }

    const synthesisAgentId = resolvedConversation.agentId;

    logger.info("storm-research: mdrag conversation resolved", {
      conversationId: resolvedConversation.conversationId,
      source: resolvedConversation.source,
      agentId: synthesisAgentId,
      externalRef: conversationExternalRef,
    });

    // Seed live progress
    metadata.replace({
      workflow: "storm-research",
      input: { topic },
      status: "running",
      generated_at: runStartedAt.toISOString(),
      current_step: 1,
      total_steps: STEP_LABELS.length,
      step_labels: STEP_LABELS,
    } satisfies StormRunProgress);

    // ── Step 1: Discover Perspectives ──────────────────────────
    logger.info("storm-research: step 1 — discovering perspectives", { topic });
    const perspectives: Perspective[] = await discoverPerspectives
      .triggerAndWait({
        topic,
        customPerspectives: payload.customPerspectives,
      })
      .unwrap();

    metadata.set("current_step", 2);

    // ── Step 2: Conduct Interviews (parallel) ─────────────────
    logger.info("storm-research: step 2 — conducting interviews", {
      perspectiveCount: perspectives.length,
    });

    const interviewBatch = await conductInterview.batchTriggerAndWait(
      perspectives.map((p) => ({ payload: { topic, perspective: p } }))
    );

    const interviewResults: InterviewResult[] = [];
    let nFailedInterviews = 0;
    for (const run of interviewBatch.runs) {
      if (run.ok) {
        interviewResults.push(run.output);
      } else {
        nFailedInterviews += 1;
        logger.error("storm-research: an interview failed; continuing with the rest", {
          error: String(run.error),
        });
      }
    }

    if (interviewResults.length === 0) {
      throw new Error("All perspective interviews failed — no research to synthesize");
    }

    logger.info("storm-research: interviews complete", {
      totalFindings: interviewResults.reduce((s, i) => s + i.findings.length, 0),
      nFailedInterviews,
    });

    metadata.set("current_step", 3);

    // ── Step 3: Map Contradictions ─────────────────────────────
    logger.info("storm-research: step 3 — mapping contradictions");
    const contradictionMap: ContradictionMap = await mapContradictions
      .triggerAndWait({ topic, interviews: interviewResults })
      .unwrap();

    logger.info("storm-research: contradictions mapped", {
      contradictions: contradictionMap.contradictions.length,
      gaps: contradictionMap.gaps.length,
    });

    metadata.set("current_step", 4);

    // ── Steps 4-5: Synthesize → Verify → Revise loop ───────────
    //
    // This is the evaluator-optimizer loop. The synthesizer writes the report,
    // the verifier checks it, and if anything fails, we loop back with corrections.
    let report: SynthesizedReport;
    let verification: VerificationReport;
    let revisionRound = 0;
    let corrections: string[] | undefined;

    do {
      revisionRound++;
      logger.info("storm-research: synthesis round", { revisionRound, maxRevisions });

      // Step 4: Synthesize — reuses the SAME resolved conversation/agent on
      // every revision round (synthesisAgentId is resolved once above the
      // loop, not re-resolved here).
      report = await synthesizeReport
        .triggerAndWait({
          topic,
          interviews: interviewResults,
          contradictionMap,
          corrections,
          agentId: synthesisAgentId,
        })
        .unwrap();

      metadata.set("current_step", 5);

      // Step 5: Verify (parallel sharding)
      const verifyBatch = await verifySources.batchTriggerAndWait(
        Array.from({ length: VERIFICATION_SHARDS }, (_, i) => ({
          payload: { topic, report, shardIndex: i, totalShards: VERIFICATION_SHARDS },
        }))
      );

      // Merge verification results from all shards
      const shardResults: VerificationReport[] = [];
      for (const run of verifyBatch.runs) {
        if (run.ok) {
          shardResults.push(run.output);
        } else {
          logger.error("storm-research: a verification shard failed", {
            shardIndex: shardResults.length,
            error: String(run.error),
          });
        }
      }

      verification = mergeVerificationReports(shardResults);

      logger.info("storm-research: verification round complete", {
        revisionRound,
        allVerified: verification.allVerified,
        correctionsNeeded: verification.correctionsNeeded.length,
      });

      if (verification.allVerified || revisionRound >= maxRevisions) {
        break;
      }

      // Build corrections for the next synthesis round
      corrections = verification.correctionsNeeded.map(
        (r) =>
          r.status === "corrected" && r.correction
            ? `Claim "${r.claim}" should be corrected to: ${r.correction} (source: ${r.source})`
            : `Claim "${r.claim}" could not be verified against source ${r.source} — ${r.note}`
      );

      metadata.set("current_step", 4); // loop back to synthesis
    } while (revisionRound < maxRevisions);

    metadata.set("current_step", 6);

    // ── Step 6: Prepare Report ─────────────────────────────────
    logger.info("storm-research: step 6 — preparing report", {
      revisionRounds: revisionRound,
      allVerified: verification.allVerified,
    });

    const briefing: StormBriefingWithMarkdown = await prepareReport
      .triggerAndWait({
        topic,
        report,
        verification,
        perspectiveCount: perspectives.length,
        contradictionCount: contradictionMap.contradictions.length,
      })
      .unwrap();

    metadata.set("current_step", 7);

    // ── Step 7: Fan out to output destinations ─────────────────
    //
    // Each destination is an independent task returning an OutputResult. A
    // destination that fails (or is missing the addressing it needs) is
    // recorded and skipped — it never fails the run, because the research
    // itself already succeeded.
    logger.info("storm-research: step 7 — delivering outputs", {
      outputs: requestedOutputs,
      slackChannel: slackChannel || "(none)",
    });

    const outputResults: OutputResult[] = [];
    let sourceIngest: SourceIngestResult = sourceIngestSkipped("not requested");

    for (const dest of requestedOutputs) {
      try {
        if (dest === "slack_briefing") {
          if (!slackChannel) {
            outputResults.push(skipped(dest, "no slackChannel or slackUserId provided"));
            continue;
          }
          outputResults.push(
            await outputSlackBriefing.triggerAndWait({ briefing, slackChannel }).unwrap()
          );
        } else if (dest === "slack_md") {
          if (!slackChannel) {
            outputResults.push(skipped(dest, "no slackChannel or slackUserId provided"));
            continue;
          }
          outputResults.push(await outputSlackMd.triggerAndWait({ briefing, slackChannel }).unwrap());
        } else if (dest === "google_doc") {
          if (!payload.slackUserId) {
            outputResults.push(skipped(dest, "no slackUserId provided"));
            continue;
          }
          outputResults.push(
            await outputGoogleDoc
              .triggerAndWait({ briefing, slackUserId: payload.slackUserId })
              .unwrap()
          );
        } else if (dest === "mdrag") {
          outputResults.push(
            await outputMdragIngest
              .triggerAndWait({
                briefing,
                topic,
                // mdrag#1034: same findings outputMdragIngestSources ingests
                // below, used here only to record source_urls on the report
                // document — see that task's `findings` doc comment.
                findings: interviewResults.flatMap((i) => i.findings),
              })
              .unwrap()
          );
          // Sibling step, same "mdrag" toggle: every unique cited source URL
          // also gets ingested, not just the composed report. Isolated in its
          // own try/catch so a crash here (the task dying outright, distinct
          // from the per-URL failures it already handles internally) is
          // reflected in `sourceIngest` rather than misattributed to
          // output-mdrag-ingest above. See jaewilson07/trigger-dev-workflows#50.
          try {
            sourceIngest = await outputMdragIngestSources
              .triggerAndWait({
                findings: interviewResults.flatMap((i) => i.findings),
                topic,
              })
              .unwrap();
          } catch (err) {
            sourceIngest = {
              status: "failed",
              success: false,
              error: err instanceof Error ? err.message : String(err),
              counts: { total: 0, queued: 0, queue_failed: 0 },
            };
          }
        } else {
          outputResults.push(skipped(dest, `unknown output destination "${dest}"`));
        }
      } catch (err) {
        outputResults.push(outputFailed(dest, err instanceof Error ? err.message : String(err)));
      }
    }

    logger.info("storm-research: outputs dispatched", { results: outputResults });

    metadata.set("status", "completed").set("generated_at", new Date().toISOString());

      logger.info("completed storm-research-full-run");

    return {
      ...briefing,
      run_id: ctx.run.id,
      started_at: runStartedAt.toISOString(),
      duration_ms: Date.now() - runStartedAt.getTime(),
      revision_rounds: revisionRound,
      outputs: outputResults,
      sourceIngest,
      mdrag_conversation_id: resolvedConversation.conversationId,
      mdrag_conversation_external_ref: conversationExternalRef,
      mdrag_conversation_source: resolvedConversation.source,
    };
  },
});

function skipped(destination: OutputDestination, reason: string): OutputResult {
  logger.warn("storm-research: skipping output destination", { destination, reason });
  // Delegates to the shared constructor (see lib/storm-types.ts): a bare
  // `{ success: false, error: "skipped — …" }` literal here would encode
  // "not attempted" identically to a real failure — the exact defect
  // storm-deliver.ts's own doc comment describes as already fixed
  // elsewhere. This file hadn't actually picked up that fix.
  return outputSkipped(destination, reason);
}

function mergeVerificationReports(shards: VerificationReport[]): VerificationReport {
  const allResults = shards.flatMap((s) => s.results);
  const allCorrections = shards.flatMap((s) => s.correctionsNeeded);
  return {
    results: allResults,
    allVerified: allCorrections.length === 0,
    correctionsNeeded: allCorrections,
  };
}
