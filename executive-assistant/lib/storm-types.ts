/**
 * Shared types for the STORM research workflow.
 *
 * These types flow through the trigger.dev task chain:
 *
 *   discover-perspectives → conduct-interview (×N parallel)
 *   → map-contradictions → synthesize-report
 *   → verify-sources (×N parallel) → prepare-report
 *   → output-* (fan-out: Slack, Google Doc, mdrag)
 *
 * The parent orchestrator (`storm-research-full-run.ts`) wires them together
 * with recursive triggerAndWait loops for the verify-and-revise cycle.
 */

/** A single expert perspective (lens) for analyzing a topic. */
export type Perspective = {
  /** Short identifier: "practitioner", "academic", "skeptic", etc. */
  lens: string;
  /** One-line role description: "Someone who has built and shipped X in production" */
  role: string;
  /** 3 initial questions this perspective would ask about the topic. */
  questions: string[];
  /** Letta Cloud agent ID to use for this perspective (EmmaBot or IdrisBot). */
  agentId: string;
  /** Agent name for logging: "EmmaBot" or "IdrisBot". */
  agentName: string;
};

/** A single research finding from one perspective's interview. */
export type Finding = {
  /** The claim or insight, in plain language. */
  claim: string;
  /** URL of the source that grounds this claim, or empty if unverified. */
  source: string;
  /** Source name (site, publication, doc title). */
  sourceName: string;
  /** Whether the source was fetched and confirmed, or just cited. */
  verified: boolean;
  /** Which perspective lens produced this finding. */
  perspective: string;
};

/** Result of one perspective's interview (one conduct-interview task run). */
export type InterviewResult = {
  perspective: Perspective;
  findings: Finding[];
  /** The perspective's summary of what they learned. */
  summary: string;
};

/** A contradiction between two or more perspectives. */
export type Contradiction = {
  /** The topic of disagreement. */
  topic: string;
  /** What one perspective claims. */
  positionA: string;
  /** Which perspective holds position A. */
  perspectiveA: string;
  /** What the other perspective claims. */
  positionB: string;
  /** Which perspective holds position B. */
  perspectiveB: string;
  /** Evidence supporting A (source URLs). */
  evidenceA: string[];
  /** Evidence supporting B (source URLs). */
  evidenceB: string[];
};

/** A gap in coverage — something no perspective thought to ask. */
export type ResearchGap = {
  /** The gap description. */
  description: string;
  /** Which lens might fill it, or "unknown" if no existing lens covers it. */
  suggestedLens: string;
  /** Follow-up questions to pursue. */
  questions: string[];
};

/** Result of the map-contradictions task. */
export type ContradictionMap = {
  contradictions: Contradiction[];
  gaps: ResearchGap[];
};

/** A section of the synthesized report. */
export type ReportSection = {
  title: string;
  /** The written content with inline citations [1], [2], etc. */
  content: string;
  /** Citations referenced in this section. */
  citations: Citation[];
};

/** A citation in the final report. */
export type Citation = {
  number: number;
  source: string;
  sourceName: string;
  /** Whether this source passed verification. */
  verified: boolean;
};

/** Result of the synthesize-report task. */
export type SynthesizedReport = {
  sections: ReportSection[];
  /** Claims that rest on a single source (flagged for the reader). */
  singleSourceClaims: string[];
};

/** Verification status for a single claim. */
export type VerificationStatus = "confirmed" | "corrected" | "demoted";

/** Result of verifying one claim against its primary source. */
export type VerificationResult = {
  claim: string;
  status: VerificationStatus;
  /** The cited source URL. */
  source: string;
  /** What was found when checking the source (or why it failed). */
  note: string;
  /** Corrected claim text, if status is "corrected". */
  correction?: string;
};

/** Result of the verify-sources task (aggregated across all verification agents). */
export type VerificationReport = {
  results: VerificationResult[];
  /** True only if every claim is "confirmed". */
  allVerified: boolean;
  /** Claims that need the report to be revised. */
  correctionsNeeded: VerificationResult[];
};

/**
 * Output of the RESEARCH half of STORM (`storm-research.ts`) — structure,
 * not rendered output. This is the seam `storm-deliver.ts` takes as its
 * input, so any caller that can produce this shape (not just
 * `storm-research` itself) can trigger delivery on its own, and re-deliver
 * without re-running the expensive research half. See
 * `docs/storm-research-rework.md`.
 */
export type StormResearch = {
  topic: string;
  report: SynthesizedReport;
  verification: VerificationReport;
  perspectiveCount: number;
  contradictionCount: number;
  /** How many synthesize→verify loops actually ran (bounded by maxRevisionRounds). */
  revisionRounds: number;
  /** Perspectives whose interview failed outright — research still proceeds on the rest. */
  failedInterviewCount: number;
  /**
   * Every finding gathered across every perspective's interview (step 2),
   * unfiltered and undeduplicated — the raw material `output-mdrag-ingest-sources`
   * needs to ingest every cited source, not just what made it into the final
   * report's citations. See jaewilson07/trigger-dev-workflows#50.
   */
  findings: Finding[];
  /** ISO timestamp of when the research half completed. */
  researched_at: string;
};

/** The final briefing output. */
export type StormBriefing = {
  topic: string;
  /** HTML-formatted report with citations. */
  html: string;
  /** Plain-text summary for Slack. */
  summary: string;
  /** Number of perspectives consulted. */
  perspectiveCount: number;
  /** Number of sources cited. */
  sourceCount: number;
  /** Number of contradictions found. */
  contradictionCount: number;
  /** Verification pass rate (0-1). */
  verificationRate: number;
};

/** Output destination options for research results */
export type OutputDestination =
  | "slack_briefing"
  | "slack_md"
  | "google_doc"
  | "mdrag"
  | "notion";

/**
 * Three-way outcome for one destination.
 *
 * `skipped` exists because it used to be encoded as failure — a destination
 * returned `{ success: false, error: "skipped — …" }`, so "no Slack channel was
 * configured" read identically to "Slack returned a 500" (see the rationale on
 * `storm-deliver`). A run that deliberately targets two of five destinations is
 * not three-fifths broken.
 */
export type OutputStatus = "delivered" | "skipped" | "failed";

/** Result of a single output task */
export type OutputResult = {
  destination: OutputDestination;
  status: OutputStatus;
  /**
   * `true` only for `delivered`. Retained alongside `status` because callers
   * and stored run records still read it; it is derived, never set by hand —
   * use the constructors below so the two can never disagree.
   */
  success: boolean;
  url?: string;
  error?: string;
};

/** Destination published successfully. `url` where the destination has one. */
export function outputDelivered(destination: OutputDestination, url?: string): OutputResult {
  return { destination, status: "delivered", success: true, ...(url ? { url } : {}) };
}

/**
 * Destination was not attempted — not requested, or not configured.
 *
 * `success: false` because nothing was published, but `status: "skipped"` is
 * what callers should branch on: this is a normal outcome, not an error, and
 * counting it as a failure is the bug this type exists to prevent.
 */
export function outputSkipped(destination: OutputDestination, reason: string): OutputResult {
  return { destination, status: "skipped", success: false, error: reason };
}

/** Destination was attempted and errored. */
export function outputFailed(destination: OutputDestination, error: string): OutputResult {
  return { destination, status: "failed", success: false, error };
}

/** Extended briefing with markdown */
export type StormBriefingWithMarkdown = StormBriefing & {
  /** Markdown version of the full report */
  markdown: string;
};

/**
 * Aggregate result of `output-mdrag-ingest-sources` — ingesting a run's every
 * unique cited source URL into mdrag. Mirrors `OutputResult`'s
 * status/success/error conventions, but one task call covers N URLs, so a
 * single `success`/`url` pair can't represent the outcome the way it does for
 * a single-document destination — `counts` replaces `url` for that reason.
 */
export type SourceIngestResult = {
  status: OutputStatus;
  /** `true` only when every source ingested successfully — see `sourceIngestCompleted`. */
  success: boolean;
  error?: string;
  counts: { total: number; succeeded: number; failed: number };
};

/** Not attempted: disabled, unconfigured, or there were no sources to ingest. */
export function sourceIngestSkipped(reason: string): SourceIngestResult {
  return { status: "skipped", success: false, error: reason, counts: { total: 0, succeeded: 0, failed: 0 } };
}

/**
 * Attempted for `counts.total` URLs. `success` (and `status: "delivered"`)
 * requires every URL to have succeeded — a partial failure is
 * `status: "failed"` so a caller branching on `success` alone can't miss it,
 * while `counts` still reports exactly how many landed vs. didn't.
 */
export function sourceIngestCompleted(counts: {
  total: number;
  succeeded: number;
  failed: number;
}): SourceIngestResult {
  const success = counts.total > 0 && counts.failed === 0;
  return {
    status: success ? "delivered" : "failed",
    success,
    counts,
    ...(success ? {} : { error: `${counts.failed} of ${counts.total} source ingest(s) failed` }),
  };
}

/** Live progress envelope (reuses the WorkflowRunResult pattern from executive-assistant). */
export type StormRunProgress = {
  workflow: "storm-research";
  input: { topic: string };
  status: "running" | "completed" | "failed";
  generated_at: string;
  current_step: number;
  total_steps: number;
  step_labels: string[];
};
