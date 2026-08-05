import { task, logger } from "@trigger.dev/sdk";
import type {
  SynthesizedReport,
  VerificationReport,
  StormBriefingWithMarkdown,
} from "../lib/storm-types.js";

export type PrepareReportPayload = {
  topic: string;
  report: SynthesizedReport;
  verification: VerificationReport;
  perspectiveCount: number;
  contradictionCount: number;
};

/**
 * prepare-report — Step 6 of STORM.
 *
 * Packages the synthesized report into HTML, Markdown, and a plain-text
 * summary. It does NOT deliver anything — delivery is the job of the
 * pluggable `output-*` tasks that the parent orchestrator fans out to
 * (output-slack-briefing, output-slack-md, output-google-doc,
 * output-mdrag-ingest).
 *
 * If verification found corrections, they are noted in the report as footnotes.
 */
export const prepareReport = task({
  id: "prepare-report",
  retry: { maxAttempts: 1 },
  run: async (payload: PrepareReportPayload): Promise<StormBriefingWithMarkdown> => {
    const { topic, report, verification, perspectiveCount, contradictionCount } = payload;

    const verificationRate =
      verification.results.length > 0
        ? verification.results.filter((r) => r.status === "confirmed").length / verification.results.length
        : 1;

    logger.info("prepare-report: packaging report", {
      topic,
      sectionCount: report.sections.length,
      verificationRate,
    });

    // Count unique sources
    const allSources = new Set<string>();
    for (const section of report.sections) {
      for (const citation of section.citations) {
        if (citation.source) allSources.add(citation.source);
      }
    }

    // Build HTML report
    const html = buildHtmlReport(topic, report, verification);

    // Build plain-text summary for Slack
    const summary = buildSlackSummary(topic, report, verification, perspectiveCount, contradictionCount);

    // Build Markdown report (for file uploads, Google Docs, and mdrag ingestion)
    const markdown = buildMarkdownReport(
      topic,
      report,
      verification,
      perspectiveCount,
      allSources.size,
      contradictionCount
    );

    return {
      topic,
      html,
      markdown,
      summary,
      perspectiveCount,
      sourceCount: allSources.size,
      contradictionCount,
      verificationRate,
    };
  },
});

function buildHtmlReport(
  topic: string,
  report: SynthesizedReport,
  verification: VerificationReport
): string {
    const corrections = verification.correctionsNeeded;

    const sectionsHtml = report.sections
      .map((section) => {
        const citationsHtml = section.citations.length > 0
          ? `<div class="citations">\n<h4>Sources</h4>\n<ol>\n${section.citations
              .map((c) => `<li><a href="${c.source}">${c.sourceName || c.source}</a> ${c.verified ? "✓" : "⚠"}</li>`)
              .join("\n")}\n</ol>\n</div>`
          : "";

        return `<section>\n<h3>${escapeHtml(section.title)}</h3>\n<div class="content">\n${escapeHtml(section.content)}\n</div>\n${citationsHtml}\n</section>`;
      })
      .join("\n\n");

    const correctionsHtml =
      corrections.length > 0
        ? `<section class="corrections">\n<h3>Verification Notes</h3>\n<ul>\n${corrections
            .map(
              (c) =>
                `<li><strong>${c.status.toUpperCase()}:</strong> ${escapeHtml(c.claim)}` +
                (c.correction ? ` — <em>Corrected: ${escapeHtml(c.correction)}</em>` : "") +
                `</li>`
            )
            .join("\n")}\n</ul>\n</section>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>STORM Research: ${escapeHtml(topic)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.8rem; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.5rem; }
  h3 { font-size: 1.2rem; margin-top: 2rem; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 2rem; }
  .citations { background: #f8f8f8; padding: 1rem; border-radius: 4px; margin-top: 1rem; }
  .citations h4 { margin-top: 0; font-size: 0.9rem; color: #666; }
  .corrections { background: #fff3cd; padding: 1rem; border-radius: 4px; }
  .corrections h3 { color: #856404; }
  a { color: #0066cc; }
</style>
</head>
<body>
<h1>${escapeHtml(topic)}</h1>
<div class="meta">
  STORM Research Briefing — ${new Date().toISOString().slice(0, 10)}<br>
  ${report.sections.length} sections | ${report.sections.reduce((s, sec) => s + sec.citations.length, 0)} citations
</div>
${sectionsHtml}
${correctionsHtml}
</body>
</html>`;
}

/**
 * Markdown rendering of the full report — the portable format used by every
 * output destination that isn't HTML (Slack file upload, Google Docs, mdrag).
 */
function buildMarkdownReport(
  topic: string,
  report: SynthesizedReport,
  verification: VerificationReport,
  perspectiveCount: number,
  sourceCount: number,
  contradictionCount: number
): string {
  const verifiedCount = verification.results.filter((r) => r.status === "confirmed").length;
  const totalCount = verification.results.length;
  const rate = totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 100;

  const sections = report.sections
    .map((section) => {
      const citations =
        section.citations.length > 0
          ? `\n### Sources\n\n${section.citations
              .map(
                (c, i) =>
                  `${i + 1}. [${c.sourceName || c.source}](${c.source})${c.verified ? " ✓" : " ⚠"}`
              )
              .join("\n")}\n`
          : "";

      return `## ${section.title}\n\n${section.content}\n${citations}`;
    })
    .join("\n");

  const corrections =
    verification.correctionsNeeded.length > 0
      ? `\n## Verification Notes\n\n${verification.correctionsNeeded
          .map(
            (c) =>
              `- **${c.status.toUpperCase()}:** ${c.claim}` +
              (c.correction ? ` — Corrected: ${c.correction}` : "")
          )
          .join("\n")}\n`
      : "";

  const singleSource =
    report.singleSourceClaims.length > 0
      ? `\n## Single-Source Claims\n\n${report.singleSourceClaims
          .map((claim) => `- ${claim}`)
          .join("\n")}\n`
      : "";

  return (
    `# STORM Research: ${topic}\n\n` +
    `**Date:** ${new Date().toISOString().slice(0, 10)}\n` +
    `**Perspectives:** ${perspectiveCount} | ` +
    `**Sources:** ${sourceCount} | ` +
    `**Contradictions:** ${contradictionCount} | ` +
    `**Verification:** ${rate}% (${verifiedCount}/${totalCount})\n\n` +
    sections +
    singleSource +
    corrections
  );
}

function buildSlackSummary(
  topic: string,
  report: SynthesizedReport,
  verification: VerificationReport,
  perspectiveCount: number,
  contradictionCount: number
): string {
  const verifiedCount = verification.results.filter((r) => r.status === "confirmed").length;
  const totalCount = verification.results.length;
  const rate = totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 100;

  const sectionSummaries = report.sections
    .map((s) => `• *${s.title}* — ${s.content.slice(0, 150)}...`)
    .join("\n");

  return (
    `*STORM Research Briefing: ${topic}*\n\n` +
    `*Perspectives:* ${perspectiveCount} | *Contradictions:* ${contradictionCount} | *Verification:* ${rate}% (${verifiedCount}/${totalCount})\n\n` +
    `*Sections:*\n${sectionSummaries}\n\n` +
    (verification.correctionsNeeded.length > 0
      ? `*Verification notes:* ${verification.correctionsNeeded.length} claims needed correction or were demoted.\n`
      : "*All claims verified against primary sources.*\n") +
    `\nFull HTML report available.`
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
