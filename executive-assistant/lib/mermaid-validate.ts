/**
 * Stage 4 of the mermaid pipeline (datacrew-site#218): real Mermaid syntax
 * validation via the actual `mermaid` package's own parser, so a broken
 * diagram is never returned as final without being labeled as such.
 *
 * Ported from datacrew-site's `lib/mermaid-validate.ts`, whose doc comment
 * explains WHY it lived there unwired: `mermaid.parse()` needs a jsdom shim
 * (an internal DOMPurify hook throws in a bare runtime), and jsdom needs
 * real Node built-ins that Cloudflare Workers' `nodejs_compat` flag does not
 * provide — so it could never run inside that repo's `export const runtime
 * = "edge"` API routes. Trigger.dev tasks run as plain Node, not an edge
 * runtime, which is the whole reason this stage finally has somewhere to
 * run for real instead of sitting validated-but-unwired.
 *
 * Confirmed working (datacrew-site, live testing): 10/12 real
 * production-generated diagrams valid, 2/12 correctly rejected for a real
 * unescaped-quote bug. Also confirmed: mermaid 11.12.0 (VS Code's "Markdown
 * Preview Mermaid Support" bundled version) parses flowchart/sequence/
 * erDiagram identically to ^11.14.0 — no version-gap risk between what this
 * validates and what a user's VS Code preview will accept.
 */

export interface MermaidValidationResult {
  valid: boolean;
  /** First line of the parser's own error message, when invalid. */
  error?: string;
}

let shimmed = false;

async function ensureDomShim(): Promise<void> {
  if (shimmed) return;
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  (globalThis as unknown as { window: unknown }).window = dom.window;
  (globalThis as unknown as { document: unknown }).document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = dom.window.DOMParser;
  shimmed = true;
}

/**
 * Parses `text` with the real mermaid grammar. Returns `{ valid: true }` or
 * `{ valid: false, error }` — never throws for a syntax error (only for a
 * genuine environment problem).
 */
export async function validateMermaidSyntax(text: string): Promise<MermaidValidationResult> {
  await ensureDomShim();
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
  try {
    await mermaid.parse(text, { suppressErrors: false });
    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message.split("\n")[0] };
  }
}
