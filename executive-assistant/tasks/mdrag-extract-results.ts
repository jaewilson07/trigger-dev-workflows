import { task, logger } from "@trigger.dev/sdk";
import { callMdragPrimitive, type MdragPrimitiveResponse } from "../lib/mdrag-primitives.js";

export type MdragExtractResultsPayload = {
  source_text: string;
  json_schema: Record<string, unknown>;
  instructions?: string;
};

/**
 * mdrag's `ExtractResultsResponse` (schema-derived). Every leaf in `result` is
 * replaced server-side by `{value, quote, start, end}` (or `null`); the schema
 * types `result` opaquely, which is all this task needs — it proves the call
 * succeeds rather than consuming the grounded values further.
 */
export type ExtractResultsResult = MdragPrimitiveResponse<"extract-results">;

export const mdragExtractResults = task({
  id: "mdrag-extract-results",
  retry: { maxAttempts: 2 },
  run: async (payload: MdragExtractResultsPayload): Promise<ExtractResultsResult> => {
    logger.info("starting mdrag-extract-results");
    return callMdragPrimitive("extract-results", {
      source_text: payload.source_text,
      json_schema: payload.json_schema,
      instructions: payload.instructions,
    });
  
    logger.info("completed mdrag-extract-results");
  },
});
