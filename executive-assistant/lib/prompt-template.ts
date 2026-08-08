/**
 * Named-variable prompt templates.
 *
 * Every prompt this workflow sends is a template with `{{named}}` slots filled
 * from the brief, never a string with a company name baked into it. The bug
 * this exists to prevent is concrete: the pattern-hunter mock had "Blue Raven
 * Solutions" written into eight findings, so a run for any other company
 * produced a report whose header said one thing and whose evidence said
 * another.
 *
 * Two rules make that failure loud instead of silent:
 *
 * 1. **Unfilled slots throw.** A `{{subject}}` with nothing to put in it is a
 *    caller bug. Rendering "Research {{subject}}" to a model gets you a
 *    confidently wrong answer about a placeholder; failing gets you a stack
 *    trace naming the missing variable.
 * 2. **Unknown variables throw.** Passing `{ compnay: "..." }` against a
 *    template that wants `company` would otherwise silently fall through to
 *    rule 1 with a misleading message, or worse, render an empty prompt.
 */

export type TemplateVars = Record<string, string | number | undefined>;

const SLOT = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Every `{{name}}` a template declares, in first-appearance order. */
export function templateSlots(template: string): string[] {
  const found = new Set<string>();
  // `match[1]` is typed `string | undefined` under noUncheckedIndexedAccess.
  // SLOT's capture group cannot be absent when the pattern matches, so this
  // guard never skips a real slot -- it just tells the compiler that.
  for (const match of template.matchAll(SLOT)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

/**
 * Fill `{{name}}` slots from `vars`.
 *
 * @throws if a declared slot has no value, or `vars` carries a key the
 *   template never declares — both are caller bugs worth surfacing at the call
 *   site rather than at the model.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const slots = templateSlots(template);
  const provided = Object.entries(vars)
    .filter(([, v]) => v !== undefined && String(v).trim() !== "")
    .map(([k]) => k);

  const missing = slots.filter((slot) => !provided.includes(slot));
  if (missing.length > 0) {
    throw new Error(
      `Prompt template is missing values for: ${missing.join(", ")}. ` +
        `Declared slots: ${slots.join(", ")}.`
    );
  }

  const unknown = provided.filter((key) => !slots.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `Prompt template got variables it does not declare: ${unknown.join(", ")}. ` +
        `Declared slots: ${slots.join(", ")}.`
    );
  }

  return template.replace(SLOT, (_full, name: string) => String(vars[name]));
}

/**
 * Same, but for a brief that is still being filled in.
 *
 * The interview runs before every field is known, so a prompt that named only
 * required fields could never mention risk tolerance. `fallbacks` supplies the
 * honest stand-in for an empty slot ("not stated yet") rather than letting the
 * model infer one from silence.
 */
export function renderWithFallbacks(
  template: string,
  vars: TemplateVars,
  fallbacks: Record<string, string> = {}
): string {
  const filled: TemplateVars = { ...vars };
  for (const slot of templateSlots(template)) {
    const value = filled[slot];
    if (value === undefined || String(value).trim() === "") {
      filled[slot] = fallbacks[slot] ?? "not stated yet";
    }
  }
  return renderTemplate(template, filled);
}
