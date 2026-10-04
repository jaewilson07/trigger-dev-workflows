import { task, logger } from "@trigger.dev/sdk";
import { classifyGraphType } from "../../lib/mermaid-classify.js";
import type { ClassifyResult } from "../../lib/mermaid-types.js";

export type MermaidClassifyPayload = {
  transcript: string;
};

export const mermaidClassifyGraphType = task({
  id: "mermaid-classify-graph-type",
  // One stateless completion (one mermaid-api pipeline turn) — same retry
  // budget as mdrag-critique's single-LLM-call task.
  retry: { maxAttempts: 2 },
  run: async (payload: MermaidClassifyPayload, { ctx }): Promise<ClassifyResult> => {
    logger.info("starting mermaid-classify-graph-type");
    const result = await classifyGraphType(payload.transcript, ctx.run.id);
    logger.info("completed mermaid-classify-graph-type", result);
    return result;
  },
});
