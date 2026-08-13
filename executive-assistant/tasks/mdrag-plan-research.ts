import { task, logger } from "@trigger.dev/sdk";
import { callMdragPrimitive, type MdragPrimitiveResponse } from "../lib/mdrag-primitives.js";

export type PlanResearchPayload = {
  topic: string;
};

/**
 * mdrag's `PlanResearchResponse`, derived from the generated OpenAPI schema
 * (`lib/mdrag-schema.ts`) rather than hand-mirrored — a field rename in mdrag
 * now surfaces as a compile error here. Note `subquestions`/`comparison_axes`
 * are optional in the schema (they carry server-side defaults), so consumers
 * must guard for `undefined`.
 */
export type PlanResearchResult = MdragPrimitiveResponse<"plan-research">;

export const mdragPlanResearch = task({
  id: "mdrag-plan-research",
  retry: { maxAttempts: 2 },
  run: async (payload: PlanResearchPayload): Promise<PlanResearchResult> => {
    logger.info("starting mdrag-plan-research");
    const result = await callMdragPrimitive("plan-research", {
      topic: payload.topic,
    });
    logger.info("completed mdrag-plan-research", {
      subquestionCount: result.subquestions?.length ?? 0,
      resolvedEntity: result.resolved_entity,
    });
    return result;
  },
});
