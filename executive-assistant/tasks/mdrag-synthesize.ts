import { task } from "@trigger.dev/sdk";
import { callMdragPrimitive, type MdragPrimitiveResponse } from "../lib/mdrag-primitives.js";
import type { components } from "../lib/mdrag-schema.js";

/** mdrag's `SynthesisFinding` — one pre-vetted claim (schema-derived). */
export type SynthesisFinding = components["schemas"]["SynthesisFinding"];

export type MdragSynthesizePayload = {
  topic: string;
  findings: SynthesisFinding[];
  comparison_axes?: string[];
};

/** mdrag's `SynthesizeResponse` (schema-derived). */
export type SynthesizeResult = MdragPrimitiveResponse<"synthesize">;

export const mdragSynthesize = task({
  id: "mdrag-synthesize",
  retry: { maxAttempts: 2 },
  run: async (payload: MdragSynthesizePayload): Promise<SynthesizeResult> => {
    return callMdragPrimitive("synthesize", {
      topic: payload.topic,
      findings: payload.findings,
      comparison_axes: payload.comparison_axes ?? [],
    });
    logger.info("completed mdrag-synthesize", { synthesisLength: result.synthesis.length });
    return result;
  },
});
