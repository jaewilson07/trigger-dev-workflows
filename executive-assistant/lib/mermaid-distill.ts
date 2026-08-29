/**
 * Stage 2 of the mermaid pipeline (datacrew-site#218): type-routed
 * distillation into a STRUCTURED intermediate spec, not prose.
 *
 * This replaces the earlier "generic prose distillation" hypothesis, which
 * an n=6 eval found genuinely mixed — it beat one-shot generation in
 * aggregate but lost on the two failure modes it was specifically meant to
 * fix. The generic version asked one model to write a plain-English
 * description of the process for a second model to re-interpret; that
 * second interpretation is exactly where new mistakes got introduced. Each
 * prompt below asks instead for the minimum structured JSON the matching
 * render stage needs to do a mechanical "spec -> Mermaid syntax" conversion
 * with no interpretation left to do — one worked example per type, so the
 * model has a concrete shape to match rather than inferring the schema from
 * a type description alone.
 */

import { logger } from "@trigger.dev/sdk";
import { extractJson } from "./letta-fallback.js";
import { completeText } from "./mermaid-llm.js";
import type {
  DiagramSpec,
  ErdSpec,
  FlowchartSpec,
  MermaidGraphType,
  SequenceSpec,
} from "./mermaid-types.js";

const FLOWCHART_PROMPT = `Distill this transcript into the steps of a process, as JSON only (no markdown fences, no prose):
{"steps": [{"id": "a", "label": "...", "next": ["b", "c"]}, ...]}

Rules:
- One node per distinct action or decision actually described. Don't invent steps the source doesn't mention.
- "next" lists the id(s) this step leads to — more than one id means a branch (e.g. a decision with two outcomes). An empty array means a terminal step.
- ids are short lowercase slugs (a, b, start, check_status, ...) — never reuse an id.

Example transcript: "First the user submits the form. Then we validate it — if it's invalid we show an error and stop, otherwise we save it and send a confirmation email."
Example output:
{"steps": [
  {"id": "submit", "label": "User submits the form", "next": ["validate"]},
  {"id": "validate", "label": "Validate the form", "next": ["error", "save"]},
  {"id": "error", "label": "Show an error", "next": []},
  {"id": "save", "label": "Save the form", "next": ["confirm"]},
  {"id": "confirm", "label": "Send a confirmation email", "next": []}
]}`;

const SEQUENCE_PROMPT = `Distill this transcript into a sequence of interactions between actors, as JSON only (no markdown fences, no prose):
{"participants": ["Alice", "Bob"], "messages": [{"from": "Alice", "to": "Bob", "label": "...", "kind": "sync"}, ...]}

Rules:
- "participants" lists every actor/system that sends or receives a message, in the order they first appear.
- "kind" is one of: "sync" (a normal call expecting a direct response), "async" (fire-and-forget, no direct reply expected), "return" (a reply to an earlier sync call), "failure" (an error/timeout response).
- Messages are in the order they actually happen. Don't invent a reply the source doesn't describe.

Example transcript: "The client calls the API to place an order. The API asks the inventory service to check stock, which replies that it's in stock, then the API confirms the order back to the client."
Example output:
{"participants": ["Client", "API", "Inventory Service"],
 "messages": [
  {"from": "Client", "to": "API", "label": "Place order", "kind": "sync"},
  {"from": "API", "to": "Inventory Service", "label": "Check stock", "kind": "sync"},
  {"from": "Inventory Service", "to": "API", "label": "In stock", "kind": "return"},
  {"from": "API", "to": "Client", "label": "Order confirmed", "kind": "return"}
 ]}`;

const ERD_PROMPT = `Distill this transcript into entities and their relationships, as JSON only (no markdown fences, no prose):
{"entities": [{"name": "...", "attributes": [{"name": "...", "attr_type": "...", "key": "PK"}]}], "relationships": [{"from": "...", "to": "...", "label": "...", "cardinality": "||--o{"}]}

Rules:
- Only include attributes the source actually describes or clearly implies (e.g. "id" as PK is safe to assume even if unstated). Don't invent columns.
- "cardinality" uses Mermaid ERD tokens read left-to-right: || = exactly one, |o = zero or one, }o = zero or more, }| = one or more. e.g. "||--o{" means "exactly one on the left, zero or more on the right".
- "key" is one of "PK" | "FK" | "UK", or omitted for a plain attribute.
- One relationships[] entry per described relationship — never restate the same fact a second time in the reverse direction ("A has many B" is ONE entry, not also a second "B belongs to A" entry).

Example transcript: "A customer can place many orders. Each order has an id, a date, and belongs to exactly one customer, who has an id and a name."
Example output:
{"entities": [
  {"name": "CUSTOMER", "attributes": [{"name": "id", "attr_type": "string", "key": "PK"}, {"name": "name", "attr_type": "string"}]},
  {"name": "ORDER", "attributes": [{"name": "id", "attr_type": "string", "key": "PK"}, {"name": "date", "attr_type": "date"}, {"name": "customer_id", "attr_type": "string", "key": "FK"}]}
 ],
 "relationships": [
  {"from": "CUSTOMER", "to": "ORDER", "label": "places", "cardinality": "||--o{"}
 ]}`;

export async function distillTranscript(
  graphType: MermaidGraphType,
  transcript: string
): Promise<DiagramSpec> {
  const prompt = promptForType(graphType);
  const reply = await completeText(prompt, `Transcript / request:\n${transcript}`, {
    temperature: 0.1,
  });
  const parsed = extractJson(reply);
  const spec = coerceSpec(graphType, parsed);
  if (spec) return spec;

  logger.warn("mermaid-distill: reply did not match the expected shape", {
    graphType,
    replyPreview: reply.trim().slice(0, 300),
  });
  throw new Error(
    `Distillation for graph_type=${graphType} did not return the expected structured shape — ` +
      `see logs for the raw reply. This should trigger the pipeline's retry, not a silent empty spec.`
  );
}

function promptForType(graphType: MermaidGraphType): string {
  switch (graphType) {
    case "flowchart":
      return FLOWCHART_PROMPT;
    case "sequence":
      return SEQUENCE_PROMPT;
    case "erd":
      return ERD_PROMPT;
  }
}

const SEQUENCE_KINDS = new Set(["sync", "async", "return", "failure"]);
const ERD_KEYS = new Set(["PK", "FK", "UK"]);

/**
 * datacrew-site#219, second defect uncovered once the duplicate-relationship
 * bug above was fixed: the model also sometimes truncates a cardinality
 * token to a single bracket character (e.g. "}--||" instead of "}o--||"),
 * which `mermaid.parse()` rejects — confirmed as the literal parse-error
 * line, `got '}'`, once the dedup fix stopped masking it. A truncated token
 * is ambiguous (could have meant "}o" zero-or-many or "}|" one-or-many —
 * two different asserted meanings), so a relationship failing this check is
 * DROPPED rather than repaired-by-guessing (see the call site in
 * `coerceErd`, which drops just that one relationship and keeps the rest of
 * the spec — not a whole-spec reject, since `distillTranscript` has no
 * retry loop to safely redo just this piece without failing the run).
 *
 * Full valid forms only: one of the 4 left-side tokens, "--" or ".." (Mermaid's
 * identifying/non-identifying line styles), one of the 4 right-side tokens.
 */
const CARDINALITY_RE = /^(\|\||\|o|\}o|\}\|)(--|\.\.)(\|\||o\||o\{|\|\{)$/;

/**
 * Shape-check the parsed JSON into the type-appropriate spec, or null if it
 * isn't one — malformed output degrades to a retry (via the thrown error in
 * `distillTranscript`), never a spec with missing/wrong-shaped fields
 * silently coerced into something render-stage would choke on differently.
 */
/** Exported for `mermaid-distill.test.ts` — pure shape-checking, no network. */
export function coerceSpec(graphType: MermaidGraphType, parsed: Record<string, unknown> | null): DiagramSpec | null {
  if (!parsed) return null;
  switch (graphType) {
    case "flowchart":
      return coerceFlowchart(parsed);
    case "sequence":
      return coerceSequence(parsed);
    case "erd":
      return coerceErd(parsed);
  }
}

function coerceFlowchart(parsed: Record<string, unknown>): FlowchartSpec | null {
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
  const steps = parsed.steps.map((raw) => {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.label !== "string") return null;
    const next = Array.isArray(r.next) ? r.next.filter((n): n is string => typeof n === "string") : [];
    return { id: r.id, label: r.label, next };
  });
  if (steps.some((s) => s === null)) return null;
  return { type: "flowchart", steps: steps as FlowchartSpec["steps"] };
}

function coerceSequence(parsed: Record<string, unknown>): SequenceSpec | null {
  if (!Array.isArray(parsed.participants) || !Array.isArray(parsed.messages)) return null;
  const participants = parsed.participants.filter((p): p is string => typeof p === "string");
  if (participants.length === 0 || parsed.messages.length === 0) return null;
  const messages = parsed.messages.map((raw) => {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.from !== "string" || typeof r.to !== "string" || typeof r.label !== "string") return null;
    const kind = typeof r.kind === "string" && SEQUENCE_KINDS.has(r.kind) ? r.kind : "sync";
    return { from: r.from, to: r.to, label: r.label, kind: kind as SequenceSpec["messages"][number]["kind"] };
  });
  if (messages.some((m) => m === null)) return null;
  return { type: "sequence", participants, messages: messages as SequenceSpec["messages"] };
}

function coerceErd(parsed: Record<string, unknown>): ErdSpec | null {
  if (!Array.isArray(parsed.entities) || parsed.entities.length === 0) return null;
  const entities = parsed.entities.map((raw) => {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string" || !Array.isArray(r.attributes)) return null;
    const attributes = r.attributes.map((a) => {
      if (typeof a !== "object" || a === null) return null;
      const ar = a as Record<string, unknown>;
      if (typeof ar.name !== "string" || typeof ar.attr_type !== "string") return null;
      const key = typeof ar.key === "string" && ERD_KEYS.has(ar.key) ? (ar.key as "PK" | "FK" | "UK") : undefined;
      return { name: ar.name, attr_type: ar.attr_type, ...(key ? { key } : {}) };
    });
    if (attributes.some((a) => a === null)) return null;
    return { name: r.name, attributes: attributes as ErdEntityAttributes };
  });
  if (entities.some((e) => e === null)) return null;

  const relationships = Array.isArray(parsed.relationships)
    ? parsed.relationships.map((raw) => {
        if (typeof raw !== "object" || raw === null) return null;
        const r = raw as Record<string, unknown>;
        if (
          typeof r.from !== "string" ||
          typeof r.to !== "string" ||
          typeof r.label !== "string" ||
          typeof r.cardinality !== "string"
        )
          return null;
        return { from: r.from, to: r.to, label: r.label, cardinality: r.cardinality };
      })
    : [];
  // A genuinely wrong-shaped relationship (missing/non-string fields) still
  // nulls the whole spec — that's a sign the reply didn't match the format
  // at all. A well-shaped relationship with a malformed cardinality TOKEN
  // specifically is handled differently, below: `distillTranscript` has no
  // retry loop of its own (unlike generate/validate's), so rejecting the
  // whole spec here would hard-fail the entire pipeline run with no diagram
  // at all — worse than the pre-#219 behavior. Dropping just that one
  // relationship keeps every valid entity/relationship and still returns
  // something to show the user, matching this pipeline's own "never
  // withhold the last attempt" philosophy (mermaid-types.ts).
  if (relationships.some((r) => r === null)) return null;

  const validRelationships = (relationships as ErdSpec["relationships"]).filter((r) => {
    if (CARDINALITY_RE.test(r.cardinality)) return true;
    logger.warn("mermaid-distill: dropping a relationship with a malformed cardinality token", {
      from: r.from,
      to: r.to,
      cardinality: r.cardinality,
    });
    return false;
  });

  return {
    type: "erd",
    entities: entities as ErdSpec["entities"],
    relationships: dedupeRelationships(validRelationships),
  };
}

type ErdEntityAttributes = ErdSpec["entities"][number]["attributes"];

/**
 * datacrew-site#219: the distillation model reliably restates the same
 * relationship from both directions (e.g. "AUTHOR ||--|| POST : has" AND
 * "POST }o--|| AUTHOR : belongs to") — confirmed as the actual
 * `mermaid.parse()` failure line on all 3 retry attempts, not incidental.
 * The retry loop's own validator feedback isn't enough signal for the model
 * to self-correct this specific mistake within 3 attempts (unlike the
 * header-token bug, which the same feedback loop does fix) — this is a
 * case worth fixing deterministically in code rather than re-prompting.
 *
 * Keyed on the unordered {from, to} entity pair alone, not on cardinality
 * agreement — the model's two directions of the "same" relationship don't
 * reliably agree on cardinality either (see the example above: "||--||" vs
 * "}o--||"), so requiring cardinality match would miss real duplicates.
 * First occurrence wins; a later one naming the same pair is dropped.
 */
export function dedupeRelationships(relationships: ErdSpec["relationships"]): ErdSpec["relationships"] {
  const seen = new Set<string>();
  const out: ErdSpec["relationships"] = [];
  for (const r of relationships) {
    const key = [r.from, r.to].sort().join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
