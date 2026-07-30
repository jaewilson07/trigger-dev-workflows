import { task, logger } from "@trigger.dev/sdk";
import { mdragPlanResearch } from "./tasks/mdrag-plan-research.js";
import type { PlanResearchResult } from "./tasks/mdrag-plan-research.js";
import { mdragSynthesize } from "./tasks/mdrag-synthesize.js";
import type { SynthesisFinding } from "./tasks/mdrag-synthesize.js";
import { mdragExtractResults } from "./tasks/mdrag-extract-results.js";
import type { ExtractResultsResult } from "./tasks/mdrag-extract-results.js";

/**
 * datacrew#298 — minimal end-to-end proof that a Trigger.dev workflow can
 * orchestrate mdrag's `/api/v1/primitives` chain over real HTTP:
 * `plan-research` -> `synthesize` -> `extract-results`, for one hardcoded
 * research topic. Deliberately NOT wired to Pattern Hunter and does no
 * Provider/web search — this is the tracer-bullet slice that has to work
 * before datacrew#300/#301/#302 (the full Pattern Hunter orchestration)
 * can depend on it.
 *
 * This is a NEW sibling workflow added to the existing `the-ai-cfo/trigger`
 * project (see `trigger.config.ts` / `package.json`) rather than a second
 * standalone TypeScript project — see this repo's PR description for why.
 * `morning-brief.ts` and every file under `tasks/` that predates this issue
 * are untouched.
 */

const DEFAULT_TOPIC = "electric vehicle battery recycling";

/**
 * Simple test schema for the extract-results demo call (issue #298 asks for
 * "a simple test JSON schema (e.g. extract one or two fields)"): one
 * required string field, one optional array field, both extractable from
 * plain synthesis prose.
 */
const DEMO_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    one_line_summary: {
      type: "string",
      description: "A single-sentence summary of the synthesized research narrative",
    },
    notable_entities: {
      type: "array",
      items: { type: "string" },
      description: "Named entities (companies, technologies, organizations) mentioned",
    },
  },
  required: ["one_line_summary"],
};

/**
 * Demo-only adapter: `synthesize` requires `findings: [{claim, source_url}]`,
 * not raw subquestions. There is no retrieval step in this slice (explicitly
 * out of scope — see issue #298's own description of this option) so each
 * `plan-research` subquestion becomes one unsourced "finding" claim. That's
 * enough to prove the plumbing end-to-end without needing a real evidence
 * step in between.
 */
function subquestionsToFindings(plan: PlanResearchResult): SynthesisFinding[] {
  return plan.subquestions.map((claim) => ({ claim, source_url: "" }));
}

export type ResearchPrimitivesDemoPayload = {
  /** Overrides DEFAULT_TOPIC. Optional — trigger with `{}` from the dashboard to use the default. */
  topic?: string;
};

export type ResearchPrimitivesDemoResult = {
  topic: string;
  plan: PlanResearchResult;
  synthesis: string;
  extraction: ExtractResultsResult;
};

/**
 * Manually trigger this task from the trigger.dev dashboard
 * (`triggers.datacrew.space`, or `localhost:8030` locally) — "Test" tab on
 * the `research-primitives-demo` task, payload `{}` (or `{"topic": "..."}`
 * to override) — to see one dashboard run with three child-task runs
 * (`mdrag-plan-research`, `mdrag-synthesize`, `mdrag-extract-results`),
 * each with its own per-step timing/logs, satisfying issue #298's
 * "demoable via Trigger.dev's own dashboard" acceptance criterion.
 */
export const researchPrimitivesDemo = task({
  id: "research-primitives-demo",
  retry: { maxAttempts: 1 },
  run: async (
    payload: ResearchPrimitivesDemoPayload = {}
  ): Promise<ResearchPrimitivesDemoResult> => {
    const topic = payload.topic?.trim() || DEFAULT_TOPIC;

    const plan = await mdragPlanResearch.triggerAndWait({ topic }).unwrap();
    logger.info("plan-research complete", {
      topic,
      subquestionCount: plan.subquestions.length,
      resolvedEntity: plan.resolved_entity,
    });

    const findings = subquestionsToFindings(plan);
    const { synthesis } = await mdragSynthesize
      .triggerAndWait({ topic, findings, comparison_axes: plan.comparison_axes })
      .unwrap();
    logger.info("synthesize complete", { synthesisLength: synthesis.length });

    const extraction = await mdragExtractResults
      .triggerAndWait({
        source_text: synthesis,
        json_schema: DEMO_EXTRACTION_SCHEMA,
        instructions: "Extract only what is explicitly stated in the synthesis text above.",
      })
      .unwrap();
    logger.info("extract-results complete", {
      answerFound: extraction.answer_found,
      completeAnswerFound: extraction.complete_answer_found,
    });

    return { topic, plan, synthesis, extraction };
  },
});
