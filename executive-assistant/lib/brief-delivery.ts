/**
 * The seam between RESEARCH and DELIVERY.
 *
 * `BriefResearch` is the whole contract: everything a destination is allowed to
 * know about the work that produced it. Deliberately NOT the rendered brief --
 * the markdown is derived from this by `synthesize-brief`, and Slack renders
 * Block Kit from the same structure (`lib/slack-blocks.ts`), while Domo needs
 * it flattened into rows (`lib/brief-rows.ts`). A destination that only ever
 * saw a markdown string could do neither.
 *
 * Keeping this in `lib/` rather than in `brief-research.ts` is what lets
 * `tasks/deliver-*.ts` type their payloads without importing a workflow that
 * imports them back.
 */

import type { TriageResult } from "../tasks/triage-emails.js";
import type { TopicSearchResult } from "./mdrag-topic-search.js";

export type BriefResearch = {
  /**
   * The day the research is ABOUT, `YYYY-MM-DD`. Stamped once by
   * `brief-research` and carried through delivery, so a run that spills past
   * midnight (or a re-delivery of yesterday's research) still writes the date
   * it researched rather than the date it happened to be rendered.
   */
  date: string;
  ownerEmail: string;
  emailCount: number;
  triageResults: TriageResult[];
  topicResults: TopicSearchResult[];
  researched_at: string;
};

export type DeliveryChannel = "slack" | "domo" | "gdoc" | "notion";

/**
 * Every delivery task takes this, plus its own destination config.
 *
 * `briefMarkdown` is passed in rather than re-synthesized per destination:
 * synthesis is one LLM-free but non-trivial render, and three destinations
 * independently producing "the brief" invites three subtly different briefs.
 */
export type BriefDeliveryBase = {
  research: BriefResearch;
  briefMarkdown: string;
  /**
   * `false` makes the task return `skipped` without doing any work. The fan-out
   * in `brief-deliver.ts` is a fixed three-entry batch (see its doc comment), so
   * "don't send to Domo this time" is expressed here, not by shortening the
   * batch.
   */
  enabled?: boolean;
};

/**
 * What a destination reports back.
 *
 * `skipped` is a RESULT, not an error -- an unconfigured destination is the
 * normal state of a fresh checkout, and the same "a well-formed refusal is not
 * a crash" convention `tasks/pattern-hunter-publish-gdoc.ts` already documents.
 * Only a genuine failure (Domo 500, Drive 403, Slack `invalid_blocks`) throws,
 * where Trigger.dev's own retry applies and, if it still fails, the aggregate
 * in `brief-deliver` records it as `failed` without taking the other two down.
 */
export type DeliveryOutcome =
  | {
      destination: "slack";
      status: "delivered";
      url: string | null;
      channel: string;
      ts: string;
      messageCount: number;
    }
  | {
      destination: "domo";
      status: "delivered";
      url: string | null;
      datasetId: string;
      uploadId: string;
      rowCount: number;
    }
  | {
      destination: "gdoc";
      status: "delivered";
      url: string;
      documentId: string;
      created: boolean;
    }
  // Structurally identical to `NotionDeliveryOutcome` in `lib/notion.ts` and to
  // the `notion` member of `ReportOutcome`, because ONE `deliver-notion` task
  // serves both seams -- see that task's docstring for why Notion did not need
  // the split `deliver-gdoc` / `report-gdoc` did.
  | {
      destination: "notion";
      status: "delivered";
      url: string;
      pageId: string;
      created: boolean;
    }
  | { destination: DeliveryChannel; status: "skipped"; reason: string };

/** A `DeliveryOutcome`, or the record of a destination task that threw. */
export type DeliveryReport =
  | DeliveryOutcome
  | { destination: DeliveryChannel; status: "failed"; error: string };

export function skipped(destination: DeliveryChannel, reason: string): DeliveryOutcome {
  return { destination, status: "skipped", reason };
}

/**
 * Narrowing helper. `reports.find(r => r.destination === "slack")` does not
 * narrow the union on its own, so callers that want one destination's detail
 * (morning-brief wants the Slack `ts` for its activity log) go through this.
 */
export function deliveredTo<C extends DeliveryChannel>(
  reports: DeliveryReport[],
  destination: C
): Extract<DeliveryOutcome, { destination: C; status: "delivered" }> | undefined {
  for (const report of reports) {
    if (report.destination === destination && report.status === "delivered") {
      return report as Extract<DeliveryOutcome, { destination: C; status: "delivered" }>;
    }
  }
  return undefined;
}
