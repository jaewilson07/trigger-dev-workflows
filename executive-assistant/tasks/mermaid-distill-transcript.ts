import { task, logger } from "@trigger.dev/sdk";
import { distillTranscript } from "../lib/mermaid-distill.js";
import type { DiagramSpec, MermaidGraphType } from "../lib/mermaid-types.js";

export type MermaidDistillPayload = {
  graph_type: MermaidGraphType;
  transcript: string;
};

export const mermaidDistillTranscript = task({
  id: "mermaid-distill-transcript",
  // distillTranscript throws on an unparseable/wrong-shaped reply on
  // purpose (see its doc comment) — that's what this retry is for.
  retry: { maxAttempts: 2 },
  run: async (payload: MermaidDistillPayload): Promise<DiagramSpec> => {
    logger.info("starting mermaid-distill-transcript", { graphType: payload.graph_type });
    const spec = await distillTranscript(payload.graph_type, payload.transcript);
    logger.info("completed mermaid-distill-transcript", { graphType: payload.graph_type });
    return spec;
  },
});
