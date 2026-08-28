/**
 * Shared types for the mermaid generation pipeline (datacrew-site#218).
 *
 * The pipeline's whole point is to stop treating "transcript in, Mermaid
 * text out" as one LLM call. Each stage below is a typed seam — same
 * convention as `docs/ADR-002-research-seam-delivery-composition.md`
 * ("structured data, not rendered output, so a destination needing a
 * different format is a new task rather than an edit"), applied inside a
 * single pipeline rather than across research/delivery halves.
 */

export const MERMAID_GRAPH_TYPES = ["flowchart", "sequence", "erd"] as const;
export type MermaidGraphType = (typeof MERMAID_GRAPH_TYPES)[number];

export function isMermaidGraphType(value: unknown): value is MermaidGraphType {
  return typeof value === "string" && (MERMAID_GRAPH_TYPES as readonly string[]).includes(value);
}

/** Stage 1 output — the state object the user's original design asked for:
 * "what is the graph type the user wants to generate" has to be answered
 * before anything downstream can be type-routed. */
export type ClassifyResult = {
  graph_type: MermaidGraphType;
  /** 0-1. Below the pipeline's threshold, the orchestrator blocks on a
   * `wait.forToken` rather than guessing silently. */
  confidence: number;
  rationale: string;
};

/** How `graph_type` was actually settled on, for the caller to display —
 * "the model guessed" and "a human confirmed" are not the same claim. */
export type GraphTypeSource = "forced" | "classifier" | "human" | "classifier-after-timeout";

// --- Stage 2 output: one structured intermediate spec per graph type -----
// Deliberately NOT prose. The whole point of routing by type before
// distilling is that the model's remaining job at generation time is a
// mechanical "spec -> syntax" conversion, not a second interpretation pass.

export type FlowchartStep = {
  id: string;
  label: string;
  /** ids of steps this one leads to. Empty = a terminal step. */
  next: string[];
};
export type FlowchartSpec = {
  type: "flowchart";
  steps: FlowchartStep[];
};

export type SequenceMessageKind = "sync" | "async" | "return" | "failure";
export type SequenceMessage = {
  from: string;
  to: string;
  label: string;
  kind: SequenceMessageKind;
};
export type SequenceSpec = {
  type: "sequence";
  participants: string[];
  messages: SequenceMessage[];
};

export type ErdAttribute = {
  name: string;
  attr_type: string;
  key?: "PK" | "FK" | "UK";
};
export type ErdEntity = {
  name: string;
  attributes: ErdAttribute[];
};
export type ErdRelationship = {
  from: string;
  to: string;
  label: string;
  /** e.g. "||--o{" — left cardinality + line style + right cardinality,
   * Mermaid ERD's own token order. Kept as one token because the pairing
   * (line style must match on both sides) is easier to validate as a unit
   * than as three separately-generated fields. */
  cardinality: string;
};
export type ErdSpec = {
  type: "erd";
  entities: ErdEntity[];
  relationships: ErdRelationship[];
};

export type DiagramSpec = FlowchartSpec | SequenceSpec | ErdSpec;

// --- Stage 4 output --------------------------------------------------------

export type ValidationResult = {
  valid: boolean;
  /** First line of the parser's own error message, when invalid. */
  error?: string;
};

export type GenerateAttempt = {
  attempt: number;
  diagram: string;
  validation: ValidationResult;
  /** Which backend produced this attempt — see mermaid-render.ts's escalation
   * tiers (stateless gateway/Letta retries, then the user's live mermaid
   * Conversation as a last resort). */
  source: "stateless" | "conversation";
};

export type MermaidPipelineResult = {
  graph_type: MermaidGraphType;
  graph_type_source: GraphTypeSource;
  classify: ClassifyResult;
  spec: DiagramSpec;
  /** The last attempt's diagram text, valid or not — never withheld, so a
   * caller can still show the user something to react to. Check `valid`
   * before treating it as ready to render silently. */
  diagram: string;
  valid: boolean;
  attempts: GenerateAttempt[];
};
