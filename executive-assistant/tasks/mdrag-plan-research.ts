import { task } from "@trigger.dev/sdk";
import { postMdragPrimitive } from "../lib/mdrag-primitives.js";

export type PlanResearchPayload = {
  topic: string;
};

/**
 * Mirrors mdrag's `PlanResearchResponse`
 * (`mdrag/src/interfaces/api/routers/primitives/models.py`), read directly
 * from source for datacrew#298 rather than guessed from the issue text.
 */
export type PlanResearchResult = {
  subquestions: string[];
  comparison_axes: string[];
  resolved_entity: string;
};

export const mdragPlanResearch = task({
  id: "mdrag-plan-research",
  retry: { maxAttempts: 2 },
  run: async (payload: PlanResearchPayload): Promise<PlanResearchResult> => {
    return postMdragPrimitive<PlanResearchResult>("plan-research", {
      topic: payload.topic,
    });
  },
});
