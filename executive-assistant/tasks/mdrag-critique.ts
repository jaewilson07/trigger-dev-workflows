import { task, logger } from "@trigger.dev/sdk";
import { callMdragPrimitive, type MdragPrimitiveResponse } from "../lib/mdrag-primitives.js";
import type { components } from "../lib/mdrag-schema.js";

/**
 * datacrew#336 — thin wrapper over mdrag's `POST /api/v1/primitives/critique`
 * (mdrag issue #900, ADR-0026), the "LLM judges result relevance" slot in
 * datacrew#336's mapping table. Request/response types are derived from mdrag's
 * generated OpenAPI schema (`lib/mdrag-schema.ts`), not hand-mirrored.
 *
 * `deep-research-query.ts` uses this to adversarially filter raw
 * `search-providers` hits before they become grounded `EvidenceResult` items
 * or synthesis input — a hit that fails critique never reaches either.
 */

/** mdrag's `CritiqueSubject` (schema-derived). */
export type MdragCritiqueSubject = components["schemas"]["CritiqueSubject"];

export type MdragCritiquePayload = {
  context?: string;
  criteria: string[];
  subjects: MdragCritiqueSubject[];
  instructions?: string;
};

/** mdrag's `CriterionVerdict` (schema-derived). */
export type MdragCriterionVerdict = components["schemas"]["CriterionVerdict"];

/** mdrag's `CritiqueVerdict` (schema-derived). */
export type MdragCritiqueVerdict = components["schemas"]["CritiqueVerdict"];

/** mdrag's `CritiqueResponse` (schema-derived). */
export type MdragCritiqueResult = MdragPrimitiveResponse<"critique">;

export const mdragCritique = task({
  id: "mdrag-critique",
  retry: { maxAttempts: 2 },
  run: async (payload: MdragCritiquePayload): Promise<MdragCritiqueResult> => {
    logger.info("starting mdrag-critique");
    const result = await callMdragPrimitive("critique", {
      context: payload.context ?? "",
      criteria: payload.criteria,
      subjects: payload.subjects.map((s) => ({
        id: s.id,
        assertion: s.assertion,
        evidence: s.evidence ?? [],
      })),
      instructions: payload.instructions,
    });
    logger.info("completed mdrag-critique", {
      overallPassed: result.overall_passed,
      verdictCount: result.verdicts?.length ?? 0,
    });
    return result;
  },
});
