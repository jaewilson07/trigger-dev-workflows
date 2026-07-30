import { task } from "@trigger.dev/sdk";
import { postMdragPrimitive } from "../lib/mdrag-primitives.js";

export type MdragExtractResultsPayload = {
  source_text: string;
  json_schema: Record<string, unknown>;
  instructions?: string;
};

/**
 * Mirrors mdrag's `ExtractResultsResponse` — every leaf in `result` is
 * replaced by `{value, quote, start, end}` (or `null`) server-side, but this
 * demo task treats `result` opaquely (`Record<string, unknown>`) rather than
 * re-deriving mdrag's grounding shape, since this slice only needs to prove
 * the call succeeds, not to consume the grounded values further.
 */
export type ExtractResultsResult = {
  answer_found: boolean;
  complete_answer_found: boolean;
  result: Record<string, unknown>;
  missing_required_fields: string[];
};

export const mdragExtractResults = task({
  id: "mdrag-extract-results",
  retry: { maxAttempts: 2 },
  run: async (payload: MdragExtractResultsPayload): Promise<ExtractResultsResult> => {
    return postMdragPrimitive<ExtractResultsResult>("extract-results", {
      source_text: payload.source_text,
      json_schema: payload.json_schema,
      instructions: payload.instructions,
    });
  },
});
