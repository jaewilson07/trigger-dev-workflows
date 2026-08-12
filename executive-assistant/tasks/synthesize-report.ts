import { task, logger } from "@trigger.dev/sdk";
import { lettaResearch, extractJson } from "../lib/letta-storm.js";
import type { InterviewResult, ContradictionMap, SynthesizedReport, ReportSection, Citation } from "../lib/storm-types.js";

export type SynthesizeReportPayload = {
  topic: string;
  interviews: InterviewResult[];
  contradictionMap: ContradictionMap;
  /** Corrections from a previous verification round (if revising). */
  corrections?: string[];
  /**
   * Letta agent to send the synthesis prompt to. Since #51, this is the
   * research run's own resolved mdrag Conversation agent (minted once per
   * run, reused across every revision round in that run) — NOT the fixed
   * shared EMMABOT_AGENT_ID perspectives/interviews still use. Required:
   * every current caller resolves a conversation before calling this task,
   * so there is no meaningful "no agent" default to fall back to — a caller
   * that forgot to resolve one should fail loudly, not silently synthesize
   * into the shared agent (defeating the point of #51).
   */
  agentId: string;
};

/**
 * synthesize-report — Step 4 of STORM.
 *
 * Groups findings by theme, dedupes overlapping claims, creates an outline,
 * and writes each section with inline citations. Marks claims resting on
 * a single source.
 *
 * If `corrections` is provided (from a failed verification round), the
 * synthesizer incorporates the corrections before writing.
 */
export const synthesizeReport = task({
  id: "synthesize-report",
  retry: { maxAttempts: 2 },
  run: async (payload: SynthesizeReportPayload): Promise<SynthesizedReport> => {
    const { topic, interviews, contradictionMap, corrections, agentId } = payload;

    if (!agentId?.trim()) {
      throw new Error("agentId is required — resolve the run's mdrag Conversation first (#51)");
    }

    logger.info("synthesize-report: starting", {
      topic,
      interviewCount: interviews.length,
      contradictionCount: contradictionMap.contradictions.length,
      hasCorrections: (corrections?.length ?? 0) > 0,
      agentId,
    });

    // Build the full research digest
    const researchDigest = interviews
      .map(
        (i) =>
          `## ${i.perspective.lens} (${i.perspective.role})\n` +
          `Summary: ${i.summary}\n` +
          `Findings:\n` +
          i.findings
            .map((f) => `- [${f.verified ? "verified" : "unverified"}] ${f.claim} (source: ${f.source || "none"}, name: ${f.sourceName || "unknown"})`)
            .join("\n")
      )
      .join("\n\n");

    const contradictionsDigest =
      contradictionMap.contradictions.length > 0
        ? `\n\n## Contradictions\n` +
          contradictionMap.contradictions
            .map(
              (c) =>
                `- ${c.topic}: ${c.perspectiveA} says "${c.positionA}" vs ${c.perspectiveB} says "${c.positionB}"`
            )
            .join("\n")
        : "";

    const correctionsNote =
      corrections && corrections.length > 0
        ? `\n\n## Corrections from verification\nThe following claims failed source verification and must be corrected or removed:\n${corrections.map((c) => `- ${c}`).join("\n")}`
        : "";

    const synthesisPrompt =
      `You are a research synthesizer writing a comprehensive report on "${topic}".\n\n` +
      `Here is the research from multiple expert perspectives:\n\n${researchDigest}${contradictionsDigest}${correctionsNote}\n\n` +
      `Write a structured report with the following:\n\n` +
      `1. Group findings by theme (not by perspective — synthesize across perspectives)\n` +
      `2. Deduplicate overlapping claims\n` +
      `3. For each section, write 2-4 paragraphs with inline citations [1], [2], etc.\n` +
      `4. Flag claims that rest on a single source with [single-source]\n` +
      `5. Address contradictions directly — present both sides and the evidence\n\n` +
      `Format your response as a JSON object with keys:\n` +
      `- "sections": array of {title, content, citations: [{number, source, sourceName, verified}]}\n` +
      `- "singleSourceClaims": array of strings (the claims that rest on a single source)`;

    const reply = await lettaResearch(
      agentId,
      "You are a research synthesizer who writes comprehensive, well-cited reports from multi-perspective research findings.",
      synthesisPrompt
    );

    const parsed = extractJson(reply);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const sections = Array.isArray(obj.sections)
        ? (obj.sections as unknown[])
            .map(coerceSection)
            .filter((s): s is ReportSection => s !== null)
        : [];
      const singleSourceClaims = Array.isArray(obj.singleSourceClaims)
        ? obj.singleSourceClaims.filter((s): s is string => typeof s === "string")
        : [];

      logger.info("synthesize-report: complete", {
        sectionCount: sections.length,
        singleSourceCount: singleSourceClaims.length,
      });

      return { sections, singleSourceClaims };
    }

    logger.warn("synthesize-report: no parseable JSON, returning raw text as single section", {
      replyPreview: reply.trim().slice(0, 200),
    });
    return {
      sections: [
        {
          title: topic,
          content: reply.trim(),
          citations: [],
        },
      ],
      singleSourceClaims: [],
    };
  },
});

function coerceSection(raw: unknown): ReportSection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== "string" || typeof r.content !== "string") return null;
  const citations: Citation[] = Array.isArray(r.citations)
    ? r.citations
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => ({
          number: typeof c.number === "number" ? c.number : 0,
          source: typeof c.source === "string" ? c.source : "",
          sourceName: typeof c.sourceName === "string" ? c.sourceName : "",
          verified: typeof c.verified === "boolean" ? c.verified : false,
        }))
    : [];
  return { title: r.title, content: r.content, citations };
}
