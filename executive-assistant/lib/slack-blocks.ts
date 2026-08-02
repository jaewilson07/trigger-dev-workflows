/**
 * Slack Block Kit rendering for the morning brief.
 *
 * WHY NOT JUST POST THE MARKDOWN. `format-brief.ts` emits GitHub-flavored
 * markdown, which Slack does not speak. Observed live on 2026-08-02: `#`/`##`
 * headings, `**bold**` and `[title](url)` all rendered literally, so the brief
 * arrived as a wall of `# Morning Brief` / `**Notification**` / `[Snowflake
 * ...](<https://...>)`. Slack's mrkdwn uses `*bold*` and `<url|title>`, and has
 * no heading syntax at all -- headings only exist as a `header` BLOCK.
 *
 * The second problem blocks solve: a >4000-char `text` gets auto-split by
 * Slack at an arbitrary character offset, which cut items in half (one chunk
 * began mid-entry with `_Proposed: keep ...`). Splitting on block boundaries
 * instead means a message never breaks inside an item.
 *
 * `format-brief.ts` is deliberately left alone and still produces the markdown
 * -- it is the `text` fallback, which Slack uses for notifications and
 * accessibility, and it keeps the 1:1 port of brief_pipeline.py intact.
 */

import type { TriageResult } from "../tasks/triage-emails.js";
import type { TopicSearchResult } from "./mdrag-topic-search.js";

export type SlackBlock = Record<string, unknown>;

// Slack's documented limits. Sections cap at 3000 chars of text and headers at
// 150; exceeding either is a 400 (`invalid_blocks`), not a truncation.
const SECTION_LIMIT = 3000;
const HEADER_LIMIT = 150;
// 50 blocks per message is the hard cap. 45 leaves room for the continuation
// header this adds to each follow-up message.
const BLOCKS_PER_MESSAGE = 45;

/**
 * Escape the three characters Slack treats as control syntax in mrkdwn.
 *
 * Without this, a subject line like `<production> alert` silently vanishes --
 * Slack parses it as a malformed link and drops it. Real senders arrive as
 * `Name <addr@example.com>`, so this is the common case, not an edge case.
 */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Slack link syntax. `|` separates url from label, so it cannot appear in either. */
function link(url: string, label: string): string {
  return `<${url.replace(/[<>|\s]/g, "")}|${esc(label).replace(/\|/g, "-")}>`;
}

function header(text: string): SlackBlock {
  // header blocks are plain_text only -- mrkdwn is ignored here, so no esc().
  return { type: "header", text: { type: "plain_text", text: truncate(text, HEADER_LIMIT), emoji: true } };
}

function section(mrkdwn: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(mrkdwn, SECTION_LIMIT) } };
}

function context(mrkdwn: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(mrkdwn, SECTION_LIMIT) }] };
}

const DIVIDER: SlackBlock = { type: "divider" };

/**
 * Pack lines into as few sections as possible without crossing the char limit.
 *
 * One section per email would blow the 50-block cap at ~45 emails and read as
 * a stack of disconnected cards; one section for everything would exceed 3000
 * chars. Packing keeps related items visually grouped and the block count low.
 */
function packSections(lines: string[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  let buffer = "";
  for (const line of lines) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length > SECTION_LIMIT && buffer) {
      blocks.push(section(buffer));
      buffer = line;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) blocks.push(section(buffer));
  return blocks;
}

/** Categories that usually want a human, surfaced above the noise. */
const PRIORITY_CATEGORIES = ["Action Required", "Client", "Personal", "Internal"];

function categoryRank(category: string): number {
  const i = PRIORITY_CATEGORIES.indexOf(category);
  return i === -1 ? PRIORITY_CATEGORIES.length : i;
}

export function buildBriefBlocks(
  triageResults: TriageResult[],
  topicResults: TopicSearchResult[],
  date = new Date().toISOString().slice(0, 10)
): SlackBlock[] {
  const blocks: SlackBlock[] = [header(`🗞️  Morning Brief — ${date}`)];

  const byCategory = new Map<string, TriageResult[]>();
  for (const t of triageResults) {
    const bucket = byCategory.get(t.category) ?? [];
    bucket.push(t);
    byCategory.set(t.category, bucket);
  }
  // Actionable categories first; ties broken by size so the long tail sinks.
  const categories = [...byCategory.entries()].sort(
    ([a, ai], [b, bi]) => categoryRank(a) - categoryRank(b) || bi.length - ai.length
  );

  const counts = categories.map(([c, items]) => `*${esc(c)}* ${items.length}`).join("   ·   ");
  blocks.push(
    context(
      `${triageResults.length} unread  ·  ${topicResults.length} topic${topicResults.length === 1 ? "" : "s"} tracked`
    )
  );
  if (counts) blocks.push(section(counts));

  for (const [category, items] of categories) {
    blocks.push(DIVIDER);
    blocks.push(section(`*${esc(category)}*  ·  ${items.length}`));
    const lines = items.map((t) => {
      const who = esc(t.sender || "unknown sender");
      const subject = esc(t.subject || "(no subject)");
      const summary = t.one_line_summary ? `\n${esc(t.one_line_summary)}` : "";
      // Confidence 0 is the degraded-verdict signal from gateway-llm, so it is
      // called out rather than shown as just another low number.
      const confidence =
        t.confidence === 0 ? "⚠️ not triaged" : `${t.proposed_action} · ${t.confidence.toFixed(2)}`;
      return `• *${subject}*\n_${who}_${summary}\n\`${confidence}\``;
    });
    blocks.push(...packSections(lines));
  }

  if (topicResults.length > 0) {
    blocks.push(DIVIDER);
    blocks.push(section("*🔎  Tracked Topics*"));
    for (const topic of topicResults) {
      const lines =
        topic.results.length === 0
          ? ["_No results found._"]
          : topic.results.slice(0, 5).map((item) => {
              const title = link(item.url, item.title || item.url);
              const snippet = item.snippet ? `\n${esc(truncate(item.snippet, 240))}` : "";
              return `• ${title}${snippet}`;
            });
      blocks.push(section(`*${esc(topic.topic)}*`));
      blocks.push(...packSections(lines));
    }
  }

  return blocks;
}

/**
 * Split blocks across messages on block boundaries, never mid-item.
 *
 * Avoids leading a continuation with a bare `divider`, which reads as an empty
 * message, and labels each continuation so a 3-message brief doesn't look like
 * three unrelated posts.
 */
export function chunkBlocks(blocks: SlackBlock[], perMessage = BLOCKS_PER_MESSAGE): SlackBlock[][] {
  if (blocks.length <= perMessage) return [blocks];

  const messages: SlackBlock[][] = [];
  let rest = blocks;
  while (rest.length > 0) {
    let take = Math.min(perMessage, rest.length);
    // Don't strand a divider as the last block of a message.
    if (take < rest.length && (rest[take - 1] as { type?: string }).type === "divider") take -= 1;
    const slice = rest.slice(0, take);
    rest = rest.slice(take);
    while (rest.length > 0 && (rest[0] as { type?: string }).type === "divider") rest = rest.slice(1);
    messages.push(
      messages.length === 0 ? slice : [context(`_Morning Brief, continued (${messages.length + 1})_`), ...slice]
    );
  }
  return messages;
}
