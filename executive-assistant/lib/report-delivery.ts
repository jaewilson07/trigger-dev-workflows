/**
 * The seam between a RESEARCH workflow and its DELIVERY half — the
 * report-shaped sibling of `lib/brief-delivery.ts`.
 *
 * WHY A SECOND SEAM AND NOT A GENERIC `BriefDeliveryBase<T>`. The audit's R1
 * suggested making `BriefDeliveryBase` generic in its payload. That works for
 * Google Docs (which only ever wants markdown) but not for the other two
 * destinations, which is the whole reason `BriefResearch` is structured rather
 * than rendered: Slack renders the brief as Block Kit from `TriageResult[]` and
 * `TopicSearchResult[]`, and Domo flattens the same into dataset rows. Pattern
 * Hunter and Deep Researcher have neither of those shapes — they have
 * `PatternHunterStep[]` — so a `BriefDeliveryBase<T>` would have left both
 * `deliver-slack` and `deliver-domo-canvas` unable to do anything with a `T`
 * they can't destructure. Two seams, each structured for the workflows that
 * feed it, is honest; one generic seam whose destinations secretly only accept
 * one shape is not.
 *
 * What the two DO share is the vocabulary — `delivered | skipped | failed`,
 * where a well-formed refusal is a result and not a crash — which is
 * deliberately identical here so the two halves read the same and a future
 * shared package can merge them without re-litigating the statuses.
 *
 * `ResearchReport` is structured, NOT rendered: `steps[]` is the same
 * `PatternHunterStep` both workflows already produce, so `report-slack` can
 * build Block Kit per step while `report-gdoc` takes the markdown, without
 * either one re-deriving the other's format. The markdown is rendered ONCE by
 * `report-deliver` and passed alongside (see `ReportDeliveryBase.markdown`).
 */

import type { PatternHunterStep } from "./pattern-hunter-types.js";

/**
 * Everything a destination is allowed to know about the research that produced
 * it. Both `pattern-hunter-deliver` and `deep-researcher-deliver` map their own
 * result onto this, so the three destination tasks below are workflow-agnostic.
 */
export type ResearchReport = {
  /** Which workflow produced this — `"pattern-hunter"`, `"deep-researcher"`. */
  workflow: string;
  /** Human-facing document title, e.g. `"Pattern Hunter — trailer rental"`. */
  title: string;
  /** What the research was ABOUT (business input, topic). */
  subject: string;
  /**
   * The day the research is ABOUT, `YYYY-MM-DD`. Stamped once by the research
   * half and carried through delivery, for the same reason `BriefResearch.date`
   * is: a re-delivery tomorrow should still title the day it researched.
   */
  date: string;
  generated_at: string;
  status: "completed" | "failed";
  /**
   * The structured findings, one entry per workflow step. This — not a
   * markdown string — is what makes the seam reusable: Slack renders these as
   * blocks, Drive renders the markdown built from them, and a future
   * destination that needs a third shape reads these rather than re-parsing
   * prose.
   */
  steps: PatternHunterStep[];
  /**
   * The GOOGLE identity to publish as (see `morning-brief.ts`'s three-identity
   * note — this is NOT the Slack id or the Letta/mdrag address). Defaults to
   * MORNING_BRIEF_GOOGLE_OWNER_EMAIL at the destination when absent.
   */
  ownerEmail?: string;
};

export type ReportChannel = "slack" | "gdoc" | "mdrag" | "notion";

/**
 * Every report destination takes this, plus its own destination config.
 *
 * `markdown` is rendered once by `report-deliver` rather than per destination:
 * three destinations independently rendering "the report" invites three subtly
 * different reports, the same reason `brief-deliver` synthesizes once.
 */
export type ReportDeliveryBase = {
  report: ResearchReport;
  markdown: string;
  /**
   * `false` makes the task return `skipped` without doing any work. The fan-out
   * in `report-deliver.ts` is a fixed three-entry batch, so "not mdrag this
   * time" is expressed here rather than by shortening the batch.
   */
  enabled?: boolean;
};

/**
 * What a report destination reports back. Mirrors `DeliveryOutcome` in
 * `lib/brief-delivery.ts` field-for-field where the destinations overlap.
 */
export type ReportOutcome =
  | {
      destination: "slack";
      status: "delivered";
      url: string | null;
      channel: string;
      ts: string;
      messageCount: number;
    }
  | {
      destination: "gdoc";
      status: "delivered";
      url: string;
      documentId: string;
      created: boolean;
    }
  | {
      destination: "mdrag";
      status: "delivered";
      url: string | null;
      documentId: string | null;
      collectionId: string;
    }
  // Structurally identical to the `notion` member of `DeliveryOutcome` in
  // `lib/brief-delivery.ts`: one `deliver-notion` task serves both seams,
  // because unlike Slack and Drive it needs nothing structural — see
  // `tasks/deliver-notion.ts`.
  | {
      destination: "notion";
      status: "delivered";
      url: string;
      pageId: string;
      created: boolean;
    }
  | { destination: ReportChannel; status: "skipped"; reason: string };

/** A `ReportOutcome`, or the record of a destination task that threw. */
export type ReportDeliveryReport =
  | ReportOutcome
  | { destination: ReportChannel; status: "failed"; error: string };

export function reportSkipped(destination: ReportChannel, reason: string): ReportOutcome {
  return { destination, status: "skipped", reason };
}

/** Narrowing helper — see `deliveredTo` in `lib/brief-delivery.ts`. */
export function reportDeliveredTo<C extends ReportChannel>(
  reports: ReportDeliveryReport[],
  destination: C
): Extract<ReportOutcome, { destination: C; status: "delivered" }> | undefined {
  for (const report of reports) {
    if (report.destination === destination && report.status === "delivered") {
      return report as Extract<ReportOutcome, { destination: C; status: "delivered" }>;
    }
  }
  return undefined;
}

/** Aggregate returned by `report-deliver` and by each workflow's own entry point. */
export type ReportDeliveryResult = {
  workflow: string;
  title: string;
  date: string;
  markdown: string;
  deliveries: ReportDeliveryReport[];
  deliveredCount: number;
  skippedCount: number;
  failedCount: number;
};
