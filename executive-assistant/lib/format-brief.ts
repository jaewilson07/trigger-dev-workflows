import type { TriageResult } from "../tasks/triage-emails.js";
import type { TopicSearchResult } from "./mdrag-topic-search.js";

/** Ported 1:1 from `scripts/brief_pipeline.py`'s `EmailTriage.format_brief`. */
export function formatBrief(
  triageResults: TriageResult[],
  topicResults: TopicSearchResult[]
): string {
  const lines: string[] = [];
  lines.push(`# Morning Brief — ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");

  lines.push(`## 📧 Inbox: ${triageResults.length} unread`);
  const byCategory = new Map<string, TriageResult[]>();
  for (const t of triageResults) {
    const bucket = byCategory.get(t.category) ?? [];
    bucket.push(t);
    byCategory.set(t.category, bucket);
  }
  for (const [category, items] of byCategory) {
    const summary = items.map((t) => `${t.subject} → ${t.proposed_action}`).join(", ");
    lines.push(`- **${category}** (${items.length}): ${summary}`);
  }
  lines.push("");

  lines.push("### Details");
  for (const t of triageResults) {
    lines.push(`- **${t.sender}** — ${t.subject}`);
    lines.push(`  ${t.one_line_summary}`);
    lines.push(`  _Proposed: ${t.proposed_action} (${t.category}, confidence ${t.confidence.toFixed(2)})_`);
  }
  lines.push("");

  lines.push("## 🔎 Tracked Topics");
  for (const topicResult of topicResults) {
    lines.push(`### ${topicResult.topic}`);
    if (topicResult.results.length === 0) {
      lines.push("_No results found._");
    }
    for (const item of topicResult.results.slice(0, 5)) {
      lines.push(`- [${item.title}](${item.url}) — ${item.snippet}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
