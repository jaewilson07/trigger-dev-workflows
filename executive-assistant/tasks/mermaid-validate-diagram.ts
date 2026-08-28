import { task, logger } from "@trigger.dev/sdk";
import { validateMermaidSyntax, type MermaidValidationResult } from "../lib/mermaid-validate.js";

export type MermaidValidatePayload = {
  diagram: string;
};

/**
 * Standalone-triggerable wrapper around real Mermaid syntax validation —
 * same reasoning as `mermaid-generate-diagram.ts`'s doc comment for why the
 * orchestrator's retry loop calls `validateMermaidSyntax` directly instead
 * of this task. Useful on its own too: any other surface with a Mermaid
 * string (not just this pipeline) can trigger this to check it, now that
 * validation finally has a Node runtime to live in (see mermaid-validate.ts's
 * doc comment on why it couldn't run in datacrew-site's edge routes).
 */
export const mermaidValidateDiagram = task({
  id: "mermaid-validate-diagram",
  retry: { maxAttempts: 1 }, // a parse failure is deterministic — retrying won't change it
  run: async (payload: MermaidValidatePayload): Promise<MermaidValidationResult> => {
    logger.info("starting mermaid-validate-diagram");
    const result = await validateMermaidSyntax(payload.diagram);
    logger.info("completed mermaid-validate-diagram", { valid: result.valid, error: result.error });
    return result;
  },
});
