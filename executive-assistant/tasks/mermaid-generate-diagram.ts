import { task, logger } from "@trigger.dev/sdk";
import { renderStateless } from "../lib/mermaid-render.js";
import type { DiagramSpec, MermaidGraphType } from "../lib/mermaid-types.js";

export type MermaidGeneratePayload = {
  graph_type: MermaidGraphType;
  spec: DiagramSpec;
  /** Feedback from a previous failed validation, to fix rather than repeat. */
  prior_error?: string;
};

export type MermaidGenerateResult = {
  diagram: string;
};

/**
 * Standalone-triggerable wrapper around the stateless render stage —
 * `mermaid-pipeline.ts`'s retry loop calls `renderStateless` directly
 * instead of this task, to keep each retry-with-feedback iteration one
 * function call rather than a new child run (the loop can fire this and
 * validate up to several times per pipeline execution). This task exists
 * for standalone triggering/dashboard visibility of the render stage alone,
 * same role `mdrag-critique` plays for its primitive.
 */
export const mermaidGenerateDiagram = task({
  id: "mermaid-generate-diagram",
  retry: { maxAttempts: 2 },
  run: async (payload: MermaidGeneratePayload): Promise<MermaidGenerateResult> => {
    logger.info("starting mermaid-generate-diagram", { graphType: payload.graph_type });
    const diagram = await renderStateless(payload.graph_type, payload.spec, payload.prior_error);
    logger.info("completed mermaid-generate-diagram", { graphType: payload.graph_type });
    return { diagram };
  },
});
