import { task, logger, metadata } from "@trigger.dev/sdk";
import { discoverPerspectives } from "./tasks/discover-perspectives.js";
import { conductInterview } from "./tasks/conduct-interview.js";
import { mapContradictions } from "./tasks/map-contradictions.js";
import { synthesizeReport } from "./tasks/synthesize-report.js";
import { verifySources } from "./tasks/verify-sources.js";
import type {
  Perspective,
  InterviewResult,
  ContradictionMap,
  SynthesizedReport,
  VerificationReport,
  StormResearch,
} from "./lib/storm-types.js";

/**
 * The RESEARCH half of STORM: steps 1-5, including the evaluator-optimizer
 * loop, producing a `StormResearch` and knowing no destination.
 *
 *   1. discover-perspectives → 5+ expert lenses for the topic
 *   2. conduct-interview (×N parallel) → each lens researches with web_search
 *   3. map-contradictions → disagreements and gaps across the lenses
 *   4. synthesize-report → themed sections with citations
 *   5. verify-sources (×6 shards) → adversarial fact-check, looping back to 4
 *
 * ## The evaluator-optimizer loop (the "agentic" part), unchanged
 *
 * After verification, if any claims failed (corrected or demoted), the workflow
 * loops back to `synthesize-report` with the corrections, until all claims are
 * confirmed OR `maxRevisionRounds` is hit. Evaluator = `verify-sources`,
 * optimizer = `synthesize-report`, loop = recursive `triggerAndWait` with
 * feedback until a quality threshold.
 *
 * ## Why the seam is HERE
 *
 * This is the expensive half — hours of Letta interviews and verification
 * shards. Everything after it (rendering, Slack, Drive, mdrag) takes seconds.
 * Splitting at this line is what makes "the research was fine, the Slack
 * channel was wrong" a re-delivery rather than a re-run. See
 * `docs/storm-research-rework.md` and `StormResearch`'s own doc comment for why
 * the seam carries structure rather than the rendered briefing.
 *
 * ## Checkpoint-resume
 *
 * trigger.dev v4 serializes the call stack after every `await`. If the runner
 * crashes or restarts mid-workflow it resumes from the last checkpoint — no
 * lost progress. That is what makes an hours-long research loop practical, and
 * it applies to this task exactly as it did to the combined one.
 *
 * ## Live progress
 *
 * `metadata.root`, not `metadata.set`: after the split, the run a caller
 * subscribes to is `storm-research-full-run` one level up, which seeds the
 * envelope. `.root` resolves to that when nested and to this run when this task
 * is triggered standalone — in both cases, the run someone is actually
 * watching. Same reasoning `executive-assistant/tasks/deep-research-level.ts`
 * documents for its own recursion.
 */

export type StormResearchPayload = {
  topic: string;
  /** Custom perspective lenses in addition to the 5 defaults. */
  customPerspectives?: string[];
  /** Max verify→revise loops. Default 2. */
  maxRevisionRounds?: number;
};

const DEFAULT_MAX_REVISIONS = 2;
const VERIFICATION_SHARDS = 6;

export const stormResearch = task({
  id: "storm-research",
  // Child tasks retry independently; re-running the whole chain would re-bill
  // every Letta interview already completed.
  retry: { maxAttempts: 1 },
  run: async (payload: StormResearchPayload): Promise<StormResearch> => {
    const topic = payload.topic?.trim();
    if (!topic) {
      throw new Error("topic is required");
    }

    const maxRevisions = payload.maxRevisionRounds ?? DEFAULT_MAX_REVISIONS;

    logger.info("starting storm-research", { topic, maxRevisions });

    // ── Step 1: Discover Perspectives ──────────────────────────
    logger.info("storm-research: step 1 — discovering perspectives", { topic });
    const perspectives: Perspective[] = await discoverPerspectives
      .triggerAndWait({
        topic,
        customPerspectives: payload.customPerspectives,
      })
      .unwrap();

    metadata.root.set("current_step", 2);

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

    metadata.root.set("current_step", 3);

    // ── Step 3: Map Contradictions ─────────────────────────────
    logger.info("storm-research: step 3 — mapping contradictions");
    const contradictionMap: ContradictionMap = await mapContradictions
      .triggerAndWait({ topic, interviews: interviewResults })
      .unwrap();

    logger.info("storm-research: contradictions mapped", {
      contradictions: contradictionMap.contradictions.length,
      gaps: contradictionMap.gaps.length,
    });

    metadata.root.set("current_step", 4);

    // ── Steps 4-5: Synthesize → Verify → Revise loop ───────────
    let report: SynthesizedReport;
    let verification: VerificationReport;
    let revisionRound = 0;
    let corrections: string[] | undefined;

    do {
      revisionRound++;
      logger.info("storm-research: synthesis round", { revisionRound, maxRevisions });

      // Step 4: Synthesize
      report = await synthesizeReport
        .triggerAndWait({
          topic,
          interviews: interviewResults,
          contradictionMap,
          corrections,
        })
        .unwrap();

      metadata.root.set("current_step", 5);

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
      corrections = verification.correctionsNeeded.map((r) =>
        r.status === "corrected" && r.correction
          ? `Claim "${r.claim}" should be corrected to: ${r.correction} (source: ${r.source})`
          : `Claim "${r.claim}" could not be verified against source ${r.source} — ${r.note}`
      );

      metadata.root.set("current_step", 4); // loop back to synthesis
    } while (revisionRound < maxRevisions);

    return {
      topic,
      report,
      verification,
      perspectiveCount: perspectives.length,
      contradictionCount: contradictionMap.contradictions.length,
      revisionRounds: revisionRound,
      failedInterviewCount: nFailedInterviews,
      findings: interviewResults.flatMap((i) => i.findings),
      researched_at: new Date().toISOString(),
    };
  },
});

function mergeVerificationReports(shards: VerificationReport[]): VerificationReport {
  const allResults = shards.flatMap((s) => s.results);
  const allCorrections = shards.flatMap((s) => s.correctionsNeeded);
  return {
    results: allResults,
    allVerified: allCorrections.length === 0,
    correctionsNeeded: allCorrections,
  };
}
