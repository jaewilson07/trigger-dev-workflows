/**
 * Redact secret-shaped substrings from text BEFORE it is posted anywhere
 * (a GitHub issue/comment, a Slack message) — jaewilson07/trigger-dev-workflows#206.
 *
 * Errors have leaked secret fragments before (a bad request URL, an auth
 * header echoed into an error message, a token pasted into a stack frame by
 * a library that didn't expect to be logged). This is a best-effort,
 * pattern-based mask, applied in order from most-specific to least-specific
 * so a matched span isn't re-matched by a broader pattern after being
 * replaced:
 *
 *   1. Named token prefixes (`ghp_`, `github_pat_`, `sk-...`, `xox[baprs]-`)
 *   2. JWTs (`eyJ....eyJ.......`)
 *   3. `password=`/`passwd=`/`pwd=`/`token=`/`secret=`/`key=` query-string-
 *      style assignments
 *   4. A URL's userinfo (`scheme://user:pass@host`)
 *   5. Generic long hex/base64 runs (>=32 chars) — a catch-all for anything
 *      secret-shaped that didn't match a named pattern above. This is
 *      deliberately conservative: it will also mask a long git SHA or a
 *      genuinely-not-secret opaque id. That's the correct trade for text
 *      about to be posted to a public-ish GitHub issue — over-redacting a
 *      non-secret is a readability cost; under-redacting a real secret is a
 *      security incident.
 *
 * Pure string -> string. No I/O, nothing async — the whole point is that
 * this can run on every code path that builds outbound text, unconditionally.
 */

const REDACTED = "[REDACTED]";

type Replacer = string | ((substring: string, ...args: string[]) => string);
type Pattern = { re: RegExp; replacement: Replacer };

const PATTERNS: Pattern[] = [
  // 1. Named token prefixes.
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: REDACTED },
  { re: /\bgho_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { re: /\bsk-[A-Za-z0-9_-]{10,}\b/g, replacement: REDACTED }, // sk-..., sk-ant-..., sk-proj-...
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },

  // 2. JWTs: header.payload.signature, each segment base64url.
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: REDACTED },

  // 3. key=value credential-shaped assignments (query string or plain text).
  //    Keeps the key name, masks only the value, so "password=hunter2" ->
  //    "password=[REDACTED]" stays legible about WHAT was redacted.
  {
    re: /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*=\s*[^\s&"'`]+/gi,
    replacement: (_m: string, ...args: string[]) => `${args[0]}=${REDACTED}`,
  },

  // 4. URL userinfo: scheme://user:pass@host -> scheme://[REDACTED]@host
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replacement: (_m: string, ...args: string[]) => `${args[0]}${REDACTED}@`,
  },

  // 5. Generic long hex or base64-shaped runs (catch-all).
  { re: /\b[a-f0-9]{32,}\b/gi, replacement: REDACTED },
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, replacement: REDACTED },
];

/** Mask every secret-shaped substring in `text`. Always returns a string, never throws. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replacement } of PATTERNS) {
    re.lastIndex = 0;
    out = typeof replacement === "string" ? out.replace(re, replacement) : out.replace(re, replacement);
  }
  return out;
}
