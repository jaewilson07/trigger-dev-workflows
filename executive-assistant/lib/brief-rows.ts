/**
 * Flattens a `BriefResearch` into the tabular shape a Domo card can render.
 *
 * Domo has no "write markdown to a canvas" API -- a dashboard card is bound to
 * a DATASET and re-renders when that dataset changes. So "update the Domo
 * canvas" is, concretely, "replace the rows of the dataset the card reads".
 * That makes the column list below a published contract with the card, not an
 * implementation detail: reordering it silently shifts every value one column
 * left, because `lib/domo-dataset.ts` uploads headerless CSV that Domo maps by
 * position.
 *
 * One wide table rather than a table per section, so a single card can filter
 * on `section` instead of the dashboard needing three datasets kept in sync.
 */

import type { BriefResearch } from "./brief-delivery.js";

/**
 * The dataset schema, in order. See `docs/morning-brief-rework.md` for the
 * Domo column types to create it with.
 */
export const DOMO_BRIEF_COLUMNS = [
  "brief_date",
  "section",
  "rank",
  "category",
  "title",
  "subtitle",
  "detail",
  "url",
  "action",
  "confidence",
] as const;

/** Domo's snippet columns are STRING; an unbounded email body would bloat the
 * upload for text no card shows. */
const DETAIL_LIMIT = 1000;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function row(values: Record<(typeof DOMO_BRIEF_COLUMNS)[number], string>): string[] {
  return DOMO_BRIEF_COLUMNS.map((column) => values[column]);
}

/**
 * Headerless rows in `DOMO_BRIEF_COLUMNS` order.
 *
 * Three sections:
 *   `summary` — one row, the roll-up counts, so a card can show them without
 *               aggregating.
 *   `inbox`   — one row per triaged email.
 *   `topic`   — one row per tracked-topic search hit.
 */
export function briefRows(research: BriefResearch): string[][] {
  const rows: string[][] = [];

  rows.push(
    row({
      brief_date: research.date,
      section: "summary",
      rank: "0",
      category: "",
      title: `${research.emailCount} unread`,
      subtitle: `${research.topicResults.length} topics tracked`,
      detail: "",
      url: "",
      action: "",
      confidence: "",
    })
  );

  research.triageResults.forEach((triage, index) => {
    rows.push(
      row({
        brief_date: research.date,
        section: "inbox",
        rank: String(index + 1),
        category: triage.category,
        title: triage.subject,
        subtitle: triage.sender,
        detail: truncate(triage.one_line_summary, DETAIL_LIMIT),
        url: "",
        action: triage.proposed_action,
        // Confidence 0 is gateway-llm's degraded-verdict signal, not a real
        // low score (`lib/slack-blocks.ts` calls it out the same way). It is
        // written as-is so a card can filter on it rather than being told a
        // guess was a measurement.
        confidence: triage.confidence.toFixed(2),
      })
    );
  });

  for (const topic of research.topicResults) {
    topic.results.forEach((item, index) => {
      rows.push(
        row({
          brief_date: research.date,
          section: "topic",
          rank: String(index + 1),
          category: topic.topic,
          title: item.title || item.url,
          subtitle: item.source,
          detail: truncate(item.snippet, DETAIL_LIMIT),
          url: item.url,
          action: "",
          confidence: "",
        })
      );
    });
  }

  return rows;
}

/**
 * The same rows WITH a header line -- for creating the dataset by hand the
 * first time (Domo > Data > CSV upload infers the schema from it). Not used by
 * the delivery task, which must stay headerless.
 */
export function briefCsvWithHeader(research: BriefResearch): string[][] {
  return [[...DOMO_BRIEF_COLUMNS], ...briefRows(research)];
}
