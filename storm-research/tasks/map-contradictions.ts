import { task, logger } from "@trigger.dev/sdk";
import { lettaResearch, extractJson, EMMABOT_AGENT_ID } from "../lib/letta-storm.js";
import type { InterviewResult, ContradictionMap, Contradiction, ResearchGap } from "../lib/storm-types.js";

export type MapContradictionsPayload = {
  topic: string;
  interviews: InterviewResult[];
};

/**
 * map-contradictions — Step 3 of STORM.
 *
 * Analyzes all interview results to find:
 * 1. Contradictions — where perspectives disagree
 * 2. Gaps — things no perspective thought to ask (unknown unknowns)
 *
 * This is the "Co-STORM moderator" function — surfacing disagreements and
 * blind spots before synthesis.
 */
export const mapContradictions = task({
  id: "map-contradictions",
  retry: { maxAttempts: 2 },
  run: async (payload: MapContradictionsPayload): Promise<ContradictionMap> => {
    const { topic, interviews } = payload;

    logger.info("map-contradictions: analyzing", {
      topic,
      interviewCount: interviews.length,
      totalFindings: interviews.reduce((sum, i) => sum + i.findings.length, 0),
    });

    // Build a compact representation of all findings for the LLM
    const findingsDigest = interviews
      .map(
        (i) =>
          `## ${i.perspective.lens}\n` +
          `Summary: ${i.summary}\n` +
          `Findings:\n` +
          i.findings
            .map((f) => `- [${f.verified ? "verified" : "unverified"}] ${f.claim} (source: ${f.source || "none"})`)
            .join("\n")
      )
      .join("\n\n");

    const analysisPrompt =
      `You are a research moderator analyzing multiple expert perspectives on "${topic}".\n\n` +
      `Here are the findings from each perspective:\n\n${findingsDigest}\n\n` +
      `Analyze these findings and identify:\n\n` +
      `1. CONTRADICTIONS: Where do perspectives disagree? For each contradiction, identify the topic, both positions, which perspectives hold them, and the evidence each side cites.\n\n` +
      `2. GAPS: What important questions did NO perspective ask? What are the "unknown unknowns"? For each gap, suggest which lens might fill it and what follow-up questions to pursue.\n\n` +
      `Format your response as a JSON object with keys "contradictions" (array of {topic, positionA, perspectiveA, positionB, perspectiveB, evidenceA, evidenceB}) and "gaps" (array of {description, suggestedLens, questions}).`;

    const reply = await lettaResearch(
      EMMABOT_AGENT_ID,
      "You are a research moderator who identifies contradictions and gaps in multi-perspective research.",
      analysisPrompt
    );

    const parsed = extractJson(reply);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const contradictions = Array.isArray(obj.contradictions)
        ? (obj.contradictions as unknown[])
            .map(coerceContradiction)
            .filter((c): c is Contradiction => c !== null)
        : [];
      const gaps = Array.isArray(obj.gaps)
        ? (obj.gaps as unknown[])
            .map(coerceGap)
            .filter((g): g is ResearchGap => g !== null)
        : [];

      logger.info("map-contradictions: complete", {
        contradictionCount: contradictions.length,
        gapCount: gaps.length,
      });

      return { contradictions, gaps };
    }

    logger.warn("map-contradictions: no parseable JSON, returning empty map", {
      replyPreview: reply.trim().slice(0, 200),
    });
    return { contradictions: [], gaps: [] };
  },
});

function coerceContradiction(raw: unknown): Contradiction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.topic !== "string" || typeof r.positionA !== "string" || typeof r.positionB !== "string") {
    return null;
  }
  return {
    topic: r.topic,
    positionA: r.positionA,
    perspectiveA: typeof r.perspectiveA === "string" ? r.perspectiveA : "",
    positionB: r.positionB,
    perspectiveB: typeof r.perspectiveB === "string" ? r.perspectiveB : "",
    evidenceA: Array.isArray(r.evidenceA) ? r.evidenceA.filter((e): e is string => typeof e === "string") : [],
    evidenceB: Array.isArray(r.evidenceB) ? r.evidenceB.filter((e): e is string => typeof e === "string") : [],
  };
}

function coerceGap(raw: unknown): ResearchGap | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.description !== "string") return null;
  return {
    description: r.description,
    suggestedLens: typeof r.suggestedLens === "string" ? r.suggestedLens : "unknown",
    questions: Array.isArray(r.questions) ? r.questions.filter((q): q is string => typeof q === "string") : [],
  };
}
