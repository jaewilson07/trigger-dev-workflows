import { task, logger } from "@trigger.dev/sdk";
import { lettaResearch, extractJson, agentIdForLens } from "../lib/letta-storm.js";
import {
  DEFAULT_PERSPECTIVES,
  buildPerspectivePrompt,
  buildQuestionGenerationPrompt,
} from "../lib/perspective-prompts.js";
import type { Perspective } from "../lib/storm-types.js";

export type DiscoverPerspectivesPayload = {
  topic: string;
  /** Optional custom perspective lenses (e.g. ["security", "legal", "ethics"]). */
  customPerspectives?: string[];
};

/**
 * discover-perspectives — Step 1 of STORM.
 *
 * Given a topic, generates 5+ expert perspectives (lenses) for analyzing it.
 * Uses the default STORM perspectives (practitioner, academic, skeptic,
 * economist, historian) plus any custom perspectives from the payload.
 *
 * For each perspective, generates 3 initial research questions.
 *
 * Each perspective is assigned a Letta Cloud agent:
 * - skeptic → IdrisBot (naturally critical persona)
 * - everything else → EmmaBot (deep research)
 */
export const discoverPerspectives = task({
  id: "discover-perspectives",
  retry: { maxAttempts: 2 },
  run: async (payload: DiscoverPerspectivesPayload): Promise<Perspective[]> => {
    logger.info("starting discover-perspectives");
    const lenses = [
      ...DEFAULT_PERSPECTIVES,
      ...(payload.customPerspectives ?? []),
    ];

    logger.info("discover-perspectives: generating questions for each lens", {
      topic: payload.topic,
      lenses,
    });

    // Generate questions for each perspective in sequence.
    // Could be parallelized, but sequential is simpler and avoids 409s.
    const perspectives: Perspective[] = [];
    for (const lens of lenses) {
      const role = roleForLens(lens);
      const agentId = agentIdForLens(lens);
      const agentName = agentId === "agent-0604eb6c-85b1-46f9-9c13-fb147d85bf2a" ? "IdrisBot" : "EmmaBot";

      const questionPrompt = buildQuestionGenerationPrompt(payload.topic, lens, role);
      const reply = await lettaResearch(
        agentId,
        buildPerspectivePrompt(lens, role),
        questionPrompt
      );

      const parsed = extractJson(reply);
      let questions: string[] = [];
      if (Array.isArray(parsed)) {
        questions = parsed.filter((q): q is string => typeof q === "string");
      } else if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.questions)) {
          questions = obj.questions.filter((q): q is string => typeof q === "string");
        }
      }

      if (questions.length === 0) {
        logger.warn("discover-perspectives: no questions parsed, using fallback", {
          lens,
          replyPreview: reply.trim().slice(0, 200),
        });
        questions = [
          `What are the key challenges with ${payload.topic} from a ${lens} perspective?`,
          `What evidence supports the mainstream view of ${payload.topic}?`,
          `What are the common misconceptions about ${payload.topic}?`,
        ];
      }

      perspectives.push({ lens, role, questions, agentId, agentName });
    }

    logger.info("discover-perspectives: complete", {
      perspectiveCount: perspectives.length,
      lenses: perspectives.map((p) => `${p.lens}→${p.agentName}`),
    });

    return perspectives;
  },
});

function roleForLens(lens: string): string {
  const roles: Record<string, string> = {
    practitioner: "Someone who has built and shipped real systems in this domain",
    academic: "A researcher with deep expertise in the academic literature",
    skeptic: "A professional skeptic who finds holes in arguments and assumptions",
    economist: "An economist who thinks in terms of incentives and markets",
    historian: "A historian who places things in historical context",
  };
  return roles[lens] ?? `An expert in ${lens}`;
}
