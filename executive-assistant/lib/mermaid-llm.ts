/**
 * Completion helper for the mermaid pipeline's classify/distill/render
 * stages. Every call is one turn to `mermaid-api`'s `/v1/pipeline/turn`
 * (`lib/mermaid-pipeline-client.ts`), which relays it to EmmaBot through the
 * mermaid-stream Letta channel (datacrew-site#247). Not the completion
 * gateway, not a direct Letta call.
 *
 * Every stage of one pipeline run passes that run's id (`ctx.run.id`), so a
 * run is one Letta conversation on the other side and the stages share
 * context. There is no default key: a caller without a run id cannot call.
 *
 * No fallback to a direct LLM path. If mermaid-api is down, unconfigured, or
 * the turn fails, the named error propagates and the run fails visibly.
 * `extractJson` (`lib/letta-fallback.ts`) still applies to replies; callers
 * own their own parsing.
 */

import { logger } from "@trigger.dev/sdk";
import { runPipelineTurn, type MermaidPipelineConfig } from "./mermaid-pipeline-client.js";

export type LlmCallOptions = {
  /** The pipeline run's id (`ctx.run.id`). Required: it is the conversation key. */
  runId: string;
  /** Kept for caller compatibility; an agent turn has no temperature knob. */
  temperature?: number;
  /** Test seam; production reads MERMAID_API_URL / MERMAID_PIPELINE_TOKEN. */
  client?: MermaidPipelineConfig;
};

export async function completeText(
  systemPrompt: string,
  userPrompt: string,
  options: LlmCallOptions
): Promise<string> {
  logger.info("mermaid-llm: pipeline turn", { runId: options.runId });
  return await runPipelineTurn(
    { runId: options.runId, text: `${systemPrompt}\n\n${userPrompt}` },
    options.client
  );
}
