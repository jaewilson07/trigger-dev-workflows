import { task, logger } from "@trigger.dev/sdk";
import { lettaResearch, parseFindings } from "../lib/letta-storm.js";
import { buildPerspectivePrompt } from "../lib/perspective-prompts.js";
import type { Perspective, Finding, InterviewResult } from "../lib/storm-types.js";

export type ConductInterviewPayload = {
  topic: string;
  perspective: Perspective;
};

/**
 * conduct-interview — Step 2 of STORM (runs in parallel, one per perspective).
 *
 * Each perspective conducts a research interview using its assigned Letta
 * Cloud agent:
 * - skeptic → IdrisBot (naturally critical persona)
 * - other lenses → EmmaBot (deep research)
 *
 * 1. Asks its initial questions about the topic
 * 2. The Letta agent uses web_search + fetch_webpage tools to find answers
 * 3. Each answer is grounded in a source (URL + source name)
 * 4. Follow-up questions are asked based on initial findings
 *
 * Returns all findings with citations and a summary.
 */
export const conductInterview = task({
  id: "conduct-interview",
  retry: { maxAttempts: 2 },
  run: async (payload: ConductInterviewPayload): Promise<InterviewResult> => {
    const { topic, perspective } = payload;
    const { lens, role, questions, agentId, agentName } = perspective;

    logger.info("conduct-interview: starting", {
      lens,
      agentName,
      topic,
      questionCount: questions.length,
    });

    // Round 1: Ask initial questions
    const round1Prompt =
      `Research the topic "${topic}" from your perspective as a ${lens} (${role}).\n\n` +
      `Answer these questions with grounded, cited findings:\n` +
      questions.map((q, i) => `${i + 1}. ${q}`).join("\n") +
      `\n\nFor each answer, search the web for sources. Include the source URL and source name for every claim.`;

    const perspectivePrompt = buildPerspectivePrompt(lens, role);
    const round1Reply = await lettaResearch(agentId, perspectivePrompt, round1Prompt);
    const round1Findings = parseFindings(round1Reply, lens);

    logger.info("conduct-interview: round 1 complete", {
      lens,
      agentName,
      findingsCount: round1Findings.length,
    });

    // Round 2: Follow-up — ask the agent to dig deeper into the most interesting finding
    const followUpPrompt =
      `Based on your initial findings about "${topic}" from the ${lens} perspective, ` +
      `identify the most surprising or contested finding and ask one follow-up question. ` +
      `Then search for the answer and provide it with sources.\n\n` +
      `Your initial findings were:\n${round1Findings.map((f) => `- ${f.claim}`).join("\n")}`;

    let followUpFindings: Array<{ claim: string; source: string; sourceName: string; verified: boolean }> = [];
    try {
      const round2Reply = await lettaResearch(agentId, perspectivePrompt, followUpPrompt);
      followUpFindings = parseFindings(round2Reply, lens);
      logger.info("conduct-interview: round 2 complete", {
        lens,
        agentName,
        followUpFindingsCount: followUpFindings.length,
      });
    } catch (err) {
      logger.warn("conduct-interview: round 2 failed, continuing with round 1 only", {
        lens,
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Merge findings — add perspective lens to each finding
    const allFindings: Finding[] = [
      ...round1Findings.map((f): Finding => ({ ...f, perspective: lens })),
      ...followUpFindings.map((f): Finding => ({ ...f, perspective: lens })),
    ];

    // Dedupe by claim text (case-insensitive)
    const seen = new Set<string>();
    const deduped = allFindings.filter((f) => {
      const key = f.claim.toLowerCase().slice(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Generate summary
    const summaryPrompt =
      `Summarize your key findings about "${topic}" from the ${lens} perspective in 2-3 sentences. ` +
      `What are the most important insights? What did you find that other perspectives might miss?`;

    let summary = "";
    try {
      summary = await lettaResearch(agentId, perspectivePrompt, summaryPrompt);
    } catch {
      summary = `${lens} perspective found ${deduped.length} findings across ${questions.length} questions.`;
    }

    logger.info("conduct-interview: complete", {
      lens,
      agentName,
      totalFindings: deduped.length,
    });

    return {
      perspective: { lens, role, questions, agentId, agentName },
      findings: deduped,
      summary,
    };
  },
});
