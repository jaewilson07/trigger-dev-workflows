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
{"participants": ["Alice", "Bob"], "messages": [{"from": "Alice", "to": "Bob", "label": "...", "kind": "sync", "source": "..."}, ...]}

Rules:
- "participants" lists every actor/system that sends or receives a message, in the order they first appear. A system the source only mentions in passing as something another actor "checks", "queries", "asks" or "calls" (a database, a cache, a third service) is still a participant — never fold its work into the caller.
- "kind" is one of: "sync" (a normal call expecting a direct response), "async" (fire-and-forget, no direct reply expected), "return" (a reply to an earlier sync call), "failure" (an error/timeout response).
- Messages are in the order they actually happen. Every call to a participant gets its own message, and a reply is included only when the source states or plainly implies what came back (e.g. "if they're valid, ..." implies the check returned a result).
- "source" is a short phrase copied VERBATIM from the transcript that justifies the message. Never invent a message you cannot quote a source for — in particular no extra "verified" / "acknowledged" confirmations the source doesn't describe.

Example transcript: "The client calls the API to place an order. The API asks the inventory service to check stock, which replies that it's in stock, then the API confirms the order back to the client."
Example output:
{"participants": ["Client", "API", "Inventory Service"],
 "messages": [
  {"from": "Client", "to": "API", "label": "Place order", "kind": "sync", "source": "The client calls the API to place an order"},
  {"from": "API", "to": "Inventory Service", "label": "Check stock", "kind": "sync", "source": "The API asks the inventory service to check stock"},
  {"from": "Inventory Service", "to": "API", "label": "In stock", "kind": "return", "source": "which replies that it's in stock"},
  {"from": "API", "to": "Client", "label": "Order confirmed", "kind": "return", "source": "the API confirms the order back to the client"}
 ]}

Example transcript (a middle hop that is easy to drop): "The web app asks the gateway to look up an account. The gateway checks the ledger database, then returns the balance to the app."
Example output:
{"participants": ["Web App", "Gateway", "Ledger Database"],
 "messages": [
  {"from": "Web App", "to": "Gateway", "label": "Look up account", "kind": "sync", "source": "The web app asks the gateway to look up an account"},
  {"from": "Gateway", "to": "Ledger Database", "label": "Check account", "kind": "sync", "source": "The gateway checks the ledger database"},
  {"from": "Gateway", "to": "Web App", "label": "Balance", "kind": "return", "source": "returns the balance to the app"}
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
  transcript: string,
  runId: string
): Promise<DiagramSpec> {
  const prompt = promptForType(graphType);
  const reply = await completeText(prompt, `Transcript / request:\n${transcript}`, {
    runId,
    temperature: 0.1,
  });
  const parsed = extractJson(reply);
  const spec = coerceSpec(graphType, parsed, transcript);
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
export function coerceSpec(
  graphType: MermaidGraphType,
  parsed: Record<string, unknown> | null,
  transcript?: string
): DiagramSpec | null {
  if (!parsed) return null;
  switch (graphType) {
    case "flowchart":
      return coerceFlowchart(parsed);
    case "sequence":
      return coerceSequence(parsed, transcript);
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

/** Lowercase and strip punctuation/whitespace runs so a quoted phrase survives trivial reformatting. */
function normalizeForQuote(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function coerceSequence(parsed: Record<string, unknown>, transcript?: string): SequenceSpec | null {
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

  // datacrew-site#223: the model invents plausible replies ("User credentials
  // verified") the transcript never states. Each message must quote its
  // source; one whose quote isn't actually in the transcript is dropped, so an
  // invented message is caught in code rather than only by the LLM judge.
  // Skipped when no transcript is supplied (shape-only callers).
  let kept = messages as SequenceSpec["messages"];
  if (transcript !== undefined) {
    const haystack = normalizeForQuote(transcript);
    kept = kept.filter((m, i) => {
      const source = (parsed.messages as Array<Record<string, unknown>>)[i].source;
      const quote = typeof source === "string" ? normalizeForQuote(source) : "";
      if (quote && haystack.includes(quote)) return true;
      logger.warn("mermaid-distill: dropping a sequence message with no verifiable source quote", {
        from: m.from,
        to: m.to,
        label: m.label,
      });
      return false;
    });
    if (kept.length === 0) return null;
  }

  // A participant a message names but "participants" omitted still has to be declared.
  const declared = new Set(participants);
  for (const m of kept) {
    for (const name of [m.from, m.to]) {
      if (!declared.has(name)) {
        declared.add(name);
        participants.push(name);
      }
    }
  }
  return { type: "sequence", participants, messages: kept };
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
