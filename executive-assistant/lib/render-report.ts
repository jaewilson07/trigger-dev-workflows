/**
 * Renders a `ResearchReport` into the two formats its destinations need:
 * markdown (Drive, mdrag) and Slack Block Kit (Slack).
 *
 * BOTH RENDERERS READ `steps[]`, not each other. `lib/slack-blocks.ts`'s module
 * docstring explains why the Slack path can't just post the markdown — Slack
 * does not speak GitHub-flavored markdown, so `#`/`**bold**`/`[a](b)` arrive
 * literally, and a >4000-char `text` gets split at an arbitrary character
 * offset. The markdown is still passed to Slack as the `text` fallback (used
 * for notifications, search and screen readers), exactly as `deliver-slack`
 * does for the brief.
 *
 * PURE FUNCTIONS, NO TASK. Rendering is cheap and deterministic, so it happens
 * inside `report-deliver` rather than in a task of its own — `synthesize-brief`
 * is a task only because it is the brief's one non-trivial synthesis step and
 * `email-digest` reuses it. Nothing reuses this independently of delivery.
 */

import type { ResearchReport } from "./report-delivery.js";
import type { PatternHunterStep, PatternResult } from "./pattern-hunter-types.js";
import type { SlackBlock } from "./slack-blocks.js";

// Slack's documented limits, same as lib/slack-blocks.ts — exceeding either is
// a 400 (`invalid_blocks`), not a truncation.
const SECTION_LIMIT = 3000;
const HEADER_LIMIT = 150;

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function link(url: string, label: string): string {
  return `<${url.replace(/[<>|\s]/g, "")}|${esc(label).replace(/\|/g, "-")}>`;
}

const STATUS_ICON: Record<string, string> = {
  done: "✅",
  failed: "❌",
  skipped: "⏭️",
  running: "⏳",
  pending: "•",
};

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * One markdown line per structured finding.
 *
 * `PatternResult` is a discriminated union of five genuinely different things
 * (see `lib/pattern-hunter-types.ts`), so each variant renders as itself rather
 * than being flattened to a generic bullet — an evidence item's whole value is
 * its citation, and a recommendation's is its action.
 */
function itemToMarkdown(item: PatternResult): string {
  switch (item.type) {
    case "evidence": {
      const cite = item.source_url ? `[${item.source_name || item.source_url}](${item.source_url})` : item.source_name;
      const quote = item.quote ? `\n  > ${item.quote.replace(/\n/g, " ")}` : "";
      return `- **${item.headline}** — ${cite}${quote}\n  _${item.relevance}_`;
    }
    case "recommendation":
      return `- **${item.action}**${item.cta_url ? ` ([${item.cta_label ?? "open"}](${item.cta_url}))` : ""}\n  _${item.relevance}_`;
    case "gap":
      return `- **${item.area}** (${item.severity}) — now: ${item.current_state}; target: ${item.target_state}\n  _${item.relevance}_`;
    case "metric":
      return `- **${item.metric_name}** (${item.direction})\n  _${item.relevance}_`;
    case "talking_point":
      return `- ${item.statement}\n  _${item.relevance}_`;
  }
}

function stepToMarkdown(step: PatternHunterStep): string {
  const icon = STATUS_ICON[step.status] ?? "•";
  const timing = step.duration_ms !== undefined ? ` _(${(step.duration_ms / 1000).toFixed(1)}s)_` : "";
  const parts = [`## ${icon} Step ${step.step} — ${step.label}${timing}`, "", step.summary];

  if (step.error) parts.push("", `> **Error:** ${step.error}`);
  if (step.narrative) parts.push("", step.narrative);
  if (step.items.length > 0) {
    parts.push("", `### Findings (${step.items.length})`, "", step.items.map(itemToMarkdown).join("\n"));
  }
  return parts.join("\n");
}

/**
 * The report as a portable markdown document — what Drive imports into a native
 * Google Doc (headings, bold, lists and links all survive that conversion; see
 * `lib/google-docs.ts`) and what mdrag ingests.
 */
export function renderReportMarkdown(report: ResearchReport): string {
  const done = report.steps.filter((s) => s.status === "done").length;
  const findings = report.steps.reduce((sum, s) => sum + s.items.length, 0);

  const head = [
    `# ${report.title}`,
    "",
    `**Subject:** ${report.subject}  `,
    `**Workflow:** ${report.workflow}  `,
    `**Date:** ${report.date}  `,
    `**Status:** ${report.status}  `,
    `**Steps:** ${done}/${report.steps.length} complete | **Findings:** ${findings}`,
    "",
    "---",
    "",
  ].join("\n");

  const body = report.steps.map(stepToMarkdown).join("\n\n---\n\n");

  const foot = ["", "---", "", `_Generated ${report.generated_at} by the ${report.workflow} workflow._`].join("\n");

  return head + body + foot;
}

// ---------------------------------------------------------------------------
// Slack Block Kit
// ---------------------------------------------------------------------------

function header(text: string): SlackBlock {
  return { type: "header", text: { type: "plain_text", text: truncate(text, HEADER_LIMIT), emoji: true } };
}

function section(mrkdwn: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(mrkdwn, SECTION_LIMIT) } };
}

function context(mrkdwn: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(mrkdwn, SECTION_LIMIT) }] };
}

/** Slack mrkdwn for one finding — the same per-variant treatment as markdown. */
function itemToMrkdwn(item: PatternResult): string {
  switch (item.type) {
    case "evidence":
      return `• ${item.source_url ? link(item.source_url, item.headline) : `*${esc(item.headline)}*`} — ${esc(item.relevance)}`;
    case "recommendation":
      return `• *${esc(item.action)}* — ${esc(item.relevance)}`;
    case "gap":
      return `• *${esc(item.area)}* (${item.severity}) — ${esc(item.relevance)}`;
    case "metric":
      return `• *${esc(item.metric_name)}* (${item.direction}) — ${esc(item.relevance)}`;
    case "talking_point":
      return `• ${esc(item.statement)}`;
  }
}

/**
 * Block Kit for the report.
 *
 * Only the first few findings per step are listed, with a count of the
 * remainder: Slack caps a message at 50 blocks and a section at 3000 chars, and
 * a research run can produce 15+ evidence items per step. The full list is what
 * the Google Doc and mdrag destinations are for — this is the notification, and
 * saying "+12 more" is honest where a silent truncation would not be.
 * `post-slack` chunks on block boundaries if this still runs long.
 */
const ITEMS_PER_STEP_IN_SLACK = 5;

export function buildReportBlocks(report: ResearchReport): SlackBlock[] {
  const done = report.steps.filter((s) => s.status === "done").length;
  const findings = report.steps.reduce((sum, s) => sum + s.items.length, 0);

  const blocks: SlackBlock[] = [
    header(report.title),
    context(
      `*${esc(report.workflow)}* · ${report.date} · ${done}/${report.steps.length} steps · ${findings} findings · status: *${report.status}*`
    ),
    { type: "divider" },
  ];

  for (const step of report.steps) {
    const icon = STATUS_ICON[step.status] ?? "•";
    const lines = [`${icon} *Step ${step.step} — ${esc(step.label)}*`, esc(step.summary)];
    if (step.error) lines.push(`_${esc(step.error)}_`);
    if (step.narrative) lines.push(truncate(esc(step.narrative), 1200));
    blocks.push(section(lines.join("\n")));

    if (step.items.length > 0) {
      const shown = step.items.slice(0, ITEMS_PER_STEP_IN_SLACK).map(itemToMrkdwn);
      const rest = step.items.length - shown.length;
      if (rest > 0) shown.push(`_+${rest} more in the full report_`);
      blocks.push(context(shown.join("\n")));
    }
  }

  return blocks;
}
