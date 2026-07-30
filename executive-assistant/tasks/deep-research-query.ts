import { task, logger } from "@trigger.dev/sdk";
import { mdragSearchProviders } from "./mdrag-search-providers.js";
import { mdragCritique } from "./mdrag-critique.js";
import type { MdragCritiqueSubject } from "./mdrag-critique.js";
import { mdragSynthesize } from "./mdrag-synthesize.js";
import type { SynthesisFinding } from "./mdrag-synthesize.js";
import { mdragExtractResults } from "./mdrag-extract-results.js";
import type { EvidenceResult } from "../lib/pattern-hunter-types.js";

/**
 * datacrew#336 — one search query's worth of retrieval + relevance filtering +
 * insight extraction, run as its OWN task so a Trigger.dev dashboard viewer
 * sees each query in a research level individually (its own timing, its own
 * retry behavior) rather than one opaque loop inside `deep-research-level.ts`.
 * This is the retrieval step `research-primitives-demo.ts` (datacrew#298)
 * explicitly said it didn't have — see that file's own module docstring.
 *
 * Chain, per datacrew#336's mapping table:
 * 1. `search-providers` ("Exa semantic search" slot) — raw web hits for `query`.
 * 2. `critique` ("LLM judges result relevance" slot) — adversarially filters
 *    those hits down to ones actually relevant to the overall research topic;
 *    a hit that fails never becomes evidence or synthesis input.
 * 3. `synthesize` — the surviving hits' snippets become synthesis `findings`,
 *    same "each subquestion/hit becomes one unsourced-or-sourced finding
 *    claim" pattern `research-primitives-demo.ts`'s `subquestionsToFindings`
 *    already established (there: unsourced, subquestions only; here: sourced,
 *    real search hits).
 * 4. `extract-results` ("Extract insights and follow-up questions" slot) —
 *    schema-constrained, grounded extraction of distinct learnings and
 *    follow-up questions out of the synthesis narrative. Follow-up questions
 *    become the next recursion level's query seed (see `deep-research-level.ts`).
 *
 * Search hits that survive critique map onto the existing `EvidenceResult`
 * `PatternResult` variant (`lib/pattern-hunter-types.ts`) with NO new type —
 * per the issue: "headline, verbatim quote, source name and URL are exactly
 * what a search result carries."
 */

const SEARCH_RESULTS_PER_QUERY = 5;

const RELEVANCE_CRITERIA = [
  "genuinely relevant to the research query, not spam, an ad, or off-topic content",
];

/**
 * `extract-results`' response wraps every leaf scalar in mandatory grounding
 * (`{value, quote, start, end}` or `null` — see mdrag's
 * `interfaces/api/routers/primitives/grounding.py` module docstring), so a
 * `string[]` field in the caller's `json_schema` comes back as an array of
 * GROUNDED leaves, not plain strings. `research-primitives-demo.ts`'s demo
 * extraction call never needed to consume `result` further so it never had to
 * unwrap this; this task does (learnings/follow-ups feed the next recursion
 * level and the final report), hence `groundedStrings` below.
 */
const LEARNINGS_SCHEMA = {
  type: "object",
  properties: {
    learnings: {
      type: "array",
      items: { type: "string" },
      description: "Distinct, factual learnings grounded in the synthesis text, one per array item",
    },
    follow_up_questions: {
      type: "array",
      items: { type: "string" },
      description: "Specific follow-up research questions raised by the synthesis, one per array item",
    },
  },
  required: ["learnings"],
};

export type DeepResearchQueryPayload = {
  /** This query's own search text — a `plan-research` subquestion at level 1,
   * or a follow-up-question-derived query at a deeper level (see
   * `deep-research-level.ts`). */
  query: string;
  /** The overall, unchanging research topic — used as `critique`'s shared
   * `context` (what every hit is judged relevant TO) even at a deep
   * recursion level whose own `query` has drifted from the original topic. */
  researchTopic: string;
  /** 1-indexed recursion depth this query belongs to — carried through only
   * for logging/step attribution, not used in any primitive call itself. */
  level: number;
};

export type DeepResearchQueryResult = {
  query: string;
  evidence: EvidenceResult[];
  learnings: string[];
  followUpQuestions: string[];
  synthesis: string;
};

function deriveSourceName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.trim() || "unknown source";
  }
}

/** Unwraps `extract-results`' mandatory grounded-leaf shape
 * (`{value, quote, start, end}` per item) back into plain strings — see this
 * file's module docstring. Silently drops a leaf whose `value` isn't a
 * non-empty string (grounding-failed-to-find leaves come back `null`, per
 * `ExtractResultsResponse`'s own contract — that is the correct, honest "not
 * found" outcome, not an error to surface here). */
function groundedStrings(field: unknown): string[] {
  if (!Array.isArray(field)) return [];
  return field
    .map((item) =>
      item && typeof item === "object" && "value" in (item as Record<string, unknown>)
        ? (item as { value: unknown }).value
        : null
    )
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

export const deepResearchQuery = task({
  id: "deep-research-query",
  retry: { maxAttempts: 2 },
  run: async (payload: DeepResearchQueryPayload): Promise<DeepResearchQueryResult> => {
    const { query, researchTopic, level } = payload;

    const search = await mdragSearchProviders
      .triggerAndWait({ text: query, limit: SEARCH_RESULTS_PER_QUERY })
      .unwrap();

    if (search.results.length === 0) {
      logger.warn("deep-research-query: search-providers returned no hits", { query, level });
      return { query, evidence: [], learnings: [], followUpQuestions: [], synthesis: "" };
    }

    const subjects: MdragCritiqueSubject[] = search.results.map((hit, i) => ({
      id: `hit-${i}`,
      assertion: [hit.title, hit.snippet].filter(Boolean).join(": ") || hit.url,
      evidence: hit.snippet ? [hit.snippet] : [],
    }));

    const critique = await mdragCritique
      .triggerAndWait({ context: researchTopic, criteria: RELEVANCE_CRITERIA, subjects })
      .unwrap();

    const passedById = new Map(critique.verdicts.map((v) => [v.subject_id, v.passed]));
    const relevantHits = search.results.filter((_, i) => passedById.get(`hit-${i}`) === true);

    if (relevantHits.length === 0) {
      logger.info("deep-research-query: critique passed none of the hits found", {
        query,
        level,
        totalHits: search.results.length,
      });
      return { query, evidence: [], learnings: [], followUpQuestions: [], synthesis: "" };
    }

    const evidence: EvidenceResult[] = relevantHits.map((hit, i) => ({
      type: "evidence" as const,
      id: `L${level}-${query.slice(0, 20).replace(/\W+/g, "-").toLowerCase()}-${i}`,
      headline: hit.title || hit.url,
      ...(hit.snippet ? { quote: hit.snippet } : {}),
      source_name: deriveSourceName(hit.url),
      source_url: hit.url,
      relevance: `Found searching "${query}" (level ${level} of researching "${researchTopic}")`,
    }));

    const findings: SynthesisFinding[] = relevantHits.map((hit) => ({
      claim: hit.snippet || hit.title,
      source_url: hit.url,
    }));

    const { synthesis } = await mdragSynthesize.triggerAndWait({ topic: query, findings }).unwrap();

    const extraction = await mdragExtractResults
      .triggerAndWait({
        source_text: synthesis,
        json_schema: LEARNINGS_SCHEMA,
        instructions: `Extract distinct factual learnings and follow-up research questions relevant to the broader research topic "${researchTopic}".`,
      })
      .unwrap();

    const resultRecord = extraction.result as Record<string, unknown>;
    const learnings = groundedStrings(resultRecord.learnings);
    const followUpQuestions = groundedStrings(resultRecord.follow_up_questions);

    logger.info("deep-research-query complete", {
      query,
      level,
      nHitsFound: search.results.length,
      nHitsPassedCritique: relevantHits.length,
      nLearnings: learnings.length,
      nFollowUpQuestions: followUpQuestions.length,
    });

    return { query, evidence, learnings, followUpQuestions, synthesis };
  },
});
