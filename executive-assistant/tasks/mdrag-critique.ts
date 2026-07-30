import { task } from "@trigger.dev/sdk";
import { postMdragPrimitive } from "../lib/mdrag-primitives.js";

/**
 * datacrew#336 — thin wrapper over mdrag's `POST /api/v1/primitives/critique`
 * (mdrag issue #900, ADR-0026), the "LLM judges result relevance" slot in
 * datacrew#336's mapping table. Mirrors
 * `mdrag/src/interfaces/api/routers/primitives/models.py`'s
 * `CritiqueRequest`/`CritiqueResponse`, read directly from source.
 *
 * `deep-research-query.ts` uses this to adversarially filter raw
 * `search-providers` hits before they become grounded `EvidenceResult` items
 * or synthesis input — a hit that fails critique never reaches either.
 */

export type MdragCritiqueSubject = {
  id: string;
  assertion: string;
  evidence?: string[];
};

export type MdragCritiquePayload = {
  context?: string;
  criteria: string[];
  subjects: MdragCritiqueSubject[];
  instructions?: string;
};

/** Mirrors mdrag's `CriterionVerdict`. */
export type MdragCriterionVerdict = {
  criterion: string;
  passed: boolean;
  rationale: string;
};

/** Mirrors mdrag's `CritiqueVerdict`. */
export type MdragCritiqueVerdict = {
  subject_id: string;
  passed: boolean;
  verdict: string;
  criteria: MdragCriterionVerdict[];
  rationale: string;
};

/** Mirrors mdrag's `CritiqueResponse`. */
export type MdragCritiqueResult = {
  verdicts: MdragCritiqueVerdict[];
  overall_passed: boolean;
};

export const mdragCritique = task({
  id: "mdrag-critique",
  retry: { maxAttempts: 2 },
  run: async (payload: MdragCritiquePayload): Promise<MdragCritiqueResult> => {
    return postMdragPrimitive<MdragCritiqueResult>("critique", {
      context: payload.context ?? "",
      criteria: payload.criteria,
      subjects: payload.subjects.map((s) => ({
        id: s.id,
        assertion: s.assertion,
        evidence: s.evidence ?? [],
      })),
      instructions: payload.instructions,
    });
  },
});
