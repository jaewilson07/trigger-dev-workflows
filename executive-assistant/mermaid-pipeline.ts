import { task, logger, metadata, wait } from "@trigger.dev/sdk";
import { classifyGraphType, LOW_CONFIDENCE_THRESHOLD } from "./lib/mermaid-classify.js";
import { distillTranscript } from "./lib/mermaid-distill.js";
import { renderStateless, renderViaConversation } from "./lib/mermaid-render.js";
import { validateMermaidSyntax } from "./lib/mermaid-validate.js";
import {
  isMermaidGraphType,
  type ClassifyResult,
  type DiagramSpec,
  type GenerateAttempt,
  type GraphTypeSource,
  type MermaidGraphType,
  type MermaidPipelineResult,
} from "./lib/mermaid-types.js";
import type { WorkflowRunResult } from "./lib/pattern-hunter-types.js";
import { forMetadata } from "./lib/pattern-hunter-types.js";

/**
 * mermaid-pipeline — the entry point for "transcript in, validated diagram
 * out" (datacrew-site#218). classify → (blocking wait if ambiguous) →
 * type-routed distill → generate/validate evaluator-optimizer loop → return.
 *
 * ## Where this sits relative to the interactive chat (mdrag#1141)
 *
 * This repo's standing principle is that trigger.dev is for non-interactive
 * workflows — interactive thinking-partner conversations belong on the
 * wiki/website. This task does not change where the mermaid CHAT lives:
 * datacrew-site's `/api/mermaid/generate` still talks directly to the
 * user's mermaid Conversation for the live, turn-by-turn revision loop the
 * UI already has. What moves here is a bounded, structured PIPELINE
 * transformation with one well-defined human-input point (`wait.forToken`
 * below), not an open-ended conversation — the same shape Pattern Hunter's
 * report-generation half already runs here while its interview half stays
 * a separate, explicitly open question (mdrag#1143). If this task ever
 * grows a second back-and-forth step, that's a sign it's drifted into
 * "interactive" territory and belongs back on the interview side of that
 * line, not a reason to add a second wait token to paper over it.
 *
 * ## The state object
 *
 * `classify` IS the state object the original design asked for — "what is
 * the graph type" has to be answered before anything downstream (which
 * distill prompt, which syntax rules, which render prompt) can run. Below
 * `LOW_CONFIDENCE_THRESHOLD`, the pipeline does not guess: it creates a
 * waitpoint token, surfaces it on `metadata.root` so a subscribing frontend
 * can prompt the user (or an agent) to pick a type, and blocks on
 * `wait.forToken` — trigger.dev's actual human-in-the-loop primitive, not a
 * polling loop this task would have to invent.
 *
 * ## The feedback loop ("never print a broken graph")
 *
 * `MAX_STATELESS_ATTEMPTS` rounds of generate→validate, each attempt fed the
 * previous one's parser error as corrective feedback — the same
 * evaluator-optimizer shape `verify-sources.ts` already uses for STORM. If
 * every stateless attempt still fails AND the caller passed a
 * `conversation_id`, one last attempt escalates to the user's own live
 * mermaid Conversation (see mermaid-render.ts's doc comment). The result
 * always carries `valid` — a caller must check it, but the last attempt's
 * diagram text is always returned even when invalid, so there is something
 * to show the user rather than nothing.
 */

const MAX_STATELESS_ATTEMPTS = 3;

export type MermaidPipelinePayload = {
  transcript: string;
  /** Skip classification — the caller (or a prior human choice) already
   * knows the type. */
  forced_graph_type?: MermaidGraphType;
  /** Enables the conversation-escalation tier. */
  conversation_id?: string;
  /** Override for eval/testing — production callers should leave this at
   * the classifier's own default. */
  low_confidence_threshold?: number;
};

type MermaidPipelineStep = {
  step: number;
  label: string;
  status: "pending" | "running" | "done" | "failed";
  duration_ms?: number;
  error?: string;
};

export const mermaidPipeline = task({
  id: "mermaid-pipeline",
  // The orchestrator itself doesn't retry — each stage already retries
  // independently, and re-running the whole thing would re-spend the wait
  // token's disambiguation step for no benefit (same reasoning as
  // pattern-hunter-full-run.ts's retry: { maxAttempts: 1 }).
  retry: { maxAttempts: 1 },
  run: async (payload: MermaidPipelinePayload, { ctx }): Promise<MermaidPipelineResult> => {
    logger.info("starting mermaid-pipeline");
    const startedAt = ctx.run.startedAt.toISOString();

    metadata.replace(
      forMetadata({
        workflow: "mermaid-pipeline",
        input: payload,
        status: "running",
        generated_at: startedAt,
        steps: [],
      } satisfies WorkflowRunResult<MermaidPipelinePayload, MermaidPipelineStep>)
    );

    // --- Stage 1: classify -------------------------------------------------
    const stage1Start = Date.now();
    const classify = await classifyGraphType(payload.transcript);
    appendStep(1, "Classify graph type", "done", Date.now() - stage1Start);

    let graphType: MermaidGraphType;
    let graphTypeSource: GraphTypeSource;
    const threshold = payload.low_confidence_threshold ?? LOW_CONFIDENCE_THRESHOLD;

    if (payload.forced_graph_type) {
      graphType = payload.forced_graph_type;
      graphTypeSource = "forced";
    } else if (classify.confidence >= threshold) {
      graphType = classify.graph_type;
      graphTypeSource = "classifier";
    } else {
      const resolved = await resolveGraphTypeViaWaitToken(classify);
      graphType = resolved.graph_type;
      graphTypeSource = resolved.source;
    }

    // --- Stage 2: type-routed distill ---------------------------------------
    const stage2Start = Date.now();
    const spec = await distillTranscript(graphType, payload.transcript);
    appendStep(2, `Distill (${graphType})`, "done", Date.now() - stage2Start);

    // --- Stage 3+4: generate/validate evaluator-optimizer loop --------------
    const stage3Start = Date.now();
    const { attempts, diagram, valid } = await generateAndValidate(
      graphType,
      spec,
      payload.conversation_id
    );
    appendStep(3, "Generate + validate", valid ? "done" : "failed", Date.now() - stage3Start);

    metadata.set("status", "completed").set("generated_at", new Date().toISOString());
    logger.info("completed mermaid-pipeline", { graphType, graphTypeSource, valid, attempts: attempts.length });

    return {
      graph_type: graphType,
      graph_type_source: graphTypeSource,
      classify,
      spec,
      diagram,
      valid,
      attempts,
    };
  },
});

function appendStep(
  step: number,
  label: string,
  status: MermaidPipelineStep["status"],
  duration_ms: number,
  error?: string
): void {
  metadata.set("current_step", step).append(
    "steps",
    forMetadata({ step, label, status, duration_ms, ...(error ? { error } : {}) } satisfies MermaidPipelineStep)
  );
}

/**
 * Blocks the run on a waitpoint token until a human (or an agent acting for
 * one) supplies a graph_type, or the token times out — in which case this
 * degrades to the classifier's own best guess rather than failing the whole
 * pipeline. `token.id`/`token.url`/`token.publicAccessToken` are surfaced on
 * `metadata.root` so a subscribing frontend can render a "which kind of
 * diagram did you mean?" prompt and complete the token directly from the
 * browser (see wait-for-token.mdx's "Completing from the browser" — the
 * public access token is scoped to exactly this waitpoint).
 */
async function resolveGraphTypeViaWaitToken(
  classify: ClassifyResult
): Promise<{ graph_type: MermaidGraphType; source: GraphTypeSource }> {
  const token = await wait.createToken({ timeout: "10m", tags: ["mermaid-graph-type"] });
  metadata.set(
    "awaiting_graph_type",
    forMetadata({
      token_id: token.id,
      token_url: token.url,
      public_access_token: token.publicAccessToken,
      guess: classify,
    })
  );
  logger.info("mermaid-pipeline: low-confidence classification, waiting for graph_type", {
    confidence: classify.confidence,
    guess: classify.graph_type,
    tokenId: token.id,
  });

  const result = await wait.forToken<{ graph_type: string }>(token);
  if (result.ok && isMermaidGraphType(result.output.graph_type)) {
    return { graph_type: result.output.graph_type, source: "human" };
  }

  logger.warn("mermaid-pipeline: graph_type wait token timed out or was malformed, defaulting to classifier guess", {
    ok: result.ok,
    guess: classify.graph_type,
  });
  return { graph_type: classify.graph_type, source: "classifier-after-timeout" };
}

async function generateAndValidate(
  graphType: MermaidGraphType,
  spec: DiagramSpec,
  conversationId?: string
): Promise<{ attempts: GenerateAttempt[]; diagram: string; valid: boolean }> {
  const attempts: GenerateAttempt[] = [];
  let priorError: string | undefined;

  for (let i = 1; i <= MAX_STATELESS_ATTEMPTS; i++) {
    const diagram = await renderStateless(graphType, spec, priorError);
    const validation = await validateMermaidSyntax(diagram);
    attempts.push({ attempt: i, diagram, validation, source: "stateless" });
    if (validation.valid) {
      return { attempts, diagram, valid: true };
    }
    priorError = validation.error;
    logger.warn("mermaid-pipeline: generate attempt failed validation", {
      attempt: i,
      graphType,
      error: validation.error,
    });
  }

  // Every stateless attempt failed — escalate to the live conversation if
  // one is available, rather than giving up on the last (still-broken)
  // stateless attempt.
  if (conversationId) {
    try {
      const diagram = await renderViaConversation(conversationId, graphType, spec, priorError ?? "unknown error");
      const validation = await validateMermaidSyntax(diagram);
      attempts.push({ attempt: attempts.length + 1, diagram, validation, source: "conversation" });
      if (validation.valid) {
        return { attempts, diagram, valid: true };
      }
      priorError = validation.error;
    } catch (err) {
      logger.error("mermaid-pipeline: conversation escalation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const last = attempts[attempts.length - 1];
  // Every branch above pushes at least one attempt before reaching here.
  if (!last) {
    throw new Error("mermaid-pipeline: no generate attempts recorded — this should be unreachable");
  }
  return { attempts, diagram: last.diagram, valid: false };
}
