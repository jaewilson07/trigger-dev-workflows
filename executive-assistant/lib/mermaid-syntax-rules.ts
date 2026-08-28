/**
 * Per-diagram-type Mermaid syntax rules, mirrored from datacrew-site's
 * `lib/mermaid-syntax-reference.ts` (same content, same sourcing) — that
 * file is the original, empirically validated against this repo's `mermaid`
 * version and against 11.12.0 (VS Code's bundled "Markdown Preview Mermaid
 * Support" version); see its doc comment for the methodology. No shared
 * npm package spans the two repos, so this is a deliberate mirror, not the
 * source of truth — if the rules change, change datacrew-site's copy first
 * and port the diff here, same as `pattern-hunter-types.ts`'s "Mirrors
 * Pattern Hunter's X" comments mirror mdrag's Pydantic models.
 *
 * Used at generation time (mermaid-render.ts), same role it plays in
 * datacrew-site's `/api/mermaid/generate` route: reduce the ONE error class
 * (unescaped special characters in labels) that prompt-level documentation
 * measurably helps with. Real validation (mermaid-validate.ts) still runs
 * after — these rules lower the retry rate, they don't replace the check.
 */

import type { MermaidGraphType } from "./mermaid-types.js";

const FLOWCHART_SYNTAX_RULES = `Mermaid flowchart syntax rules — follow exactly:
- The FIRST line must be exactly "flowchart TD" (or "graph TD") — this exact token, nothing else, no other text on that line.
- If a node's label text contains ANY punctuation, quotes, or special characters, wrap the ENTIRE label in double quotes: A["like this"].
- To include a literal double-quote character inside a label, use the HTML entity #quot; instead of a raw " character — e.g. A["He said #quot;hello#quot;"]. Never leave a raw " inside an unquoted [...] label; this is the most common cause of parse failures.
- Other special characters (e.g. #) can be escaped the same way with their entity code (#35; for #).
- The word "end" (any case, alone) must never appear as a bare node id or label — wrap it in quotes or brackets instead.
- One node per distinct step. Do not split a single action into a separate statement node and decision node unless the source actually describes a branch.`;

const SEQUENCE_SYNTAX_RULES = `Mermaid sequence diagram syntax rules — follow exactly:
- The FIRST line must be exactly "sequenceDiagram" — this exact token (this exact capitalization: lowercase s, capital D), nothing else on that line.
- Arrow types: ->> (solid, arrowhead), -->> (dotted, arrowhead), -x (solid, cross/failure), --x (dotted, cross), -) (solid, async/open arrow), --) (dotted, async). Use ->>/-->> for a normal request/response pair, not a bare ->/--> (those render without an arrowhead).
- Give a participant an alias when its name has spaces or line breaks: participant A as Alice.
- The word "end" (any case, alone) must never appear as a bare label — wrap it in quotes.
- Escape semicolons in message text as #59; — a raw ; is interpreted as a line break, not literal punctuation.
- Escape other special characters the same way with their HTML entity code (#35; for #, #quot; for a literal ").`;

const ERD_SYNTAX_RULES = `Mermaid entity-relationship diagram syntax rules — follow exactly:
- The FIRST line must be exactly "erDiagram" — this exact token (this exact capitalization: lowercase e, lowercase r, capital D), nothing else on that line. Never "ERDiagram", "ERdiagram", or "erdiagram" — those fail to parse.
- Relationship syntax: <ENTITY_A> <left-cardinality><line><right-cardinality> <ENTITY_B> : label
  Cardinality tokens: |o = zero or one, || = exactly one, }o = zero or more, }| = one or more (mirror on the right: o|, ||, o{, |{).
  Line style: -- = identifying relationship, .. = non-identifying.
  Example: CUSTOMER ||--o{ ORDER : places — read this as "one CUSTOMER relates to zero-or-more ORDER". The "one" (or "zero-or-one") side is always the entity written FIRST when the relationship is "one X has many Y".
- Emit exactly ONE relationship line per described relationship — never restate the same relationship a second time from the other entity's perspective (that produces a contradictory duplicate, e.g. both "A ||--o{ B" and "B }o--|| A" for the same fact). Pick one direction and state it once.
- An entity name containing spaces must be double-quoted: "line item".
- Attributes go inside braces as "type name" pairs, one per line: ENTITY { string id PK }. Mark keys with PK/FK/UK after the name; add a double-quoted comment at the end of the line if useful.
- Keep it to entities, relationships, and cardinality — don't invent attributes the source didn't describe.`;

export function syntaxRulesForType(graphType: MermaidGraphType): string {
  switch (graphType) {
    case "flowchart":
      return FLOWCHART_SYNTAX_RULES;
    case "sequence":
      return SEQUENCE_SYNTAX_RULES;
    case "erd":
      return ERD_SYNTAX_RULES;
  }
}
