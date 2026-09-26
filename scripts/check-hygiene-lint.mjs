#!/usr/bin/env node
/**
 * A small ratchet lint, modeled on `scripts/check-trigger-logging.mjs`
 * (same shape: a plain regex/text scan over checked-in `.ts` files, wired
 * into `.pre-commit-config.yaml` as a `language: system` local hook so it
 * runs both in CI (`pre-commit run --all-files`) and locally via
 * `.githooks/pre-commit`) — jaewilson07/trigger-dev-workflows#206, item 2.
 *
 * Unlike `check-trigger-logging.mjs` (a hard rule with no exceptions), this
 * one is a RATCHET: every rule below already has one or more legitimate
 * pre-existing instances in this repo (see `scripts/hygiene-lint-baseline.json`),
 * so a bare "fail on any match" would never have landed green. Instead:
 * every match is looked up in the baseline by a per-rule key; a match whose
 * key IS in the baseline is reported (so `--all` output stays honest about
 * what exists) but does not fail the run; a match whose key is NOT in the
 * baseline is a genuinely NEW instance of the pattern and fails. The
 * baseline only ever needs to shrink (fixing one of today's instances) or
 * gain a deliberate new entry (someone reviewing a PR decides a new
 * exception is warranted) — it is never required reading to add an
 * unrelated task.
 *
 * Five checks, each independent and each documented at its own function:
 *   1. getSecret-runtime-in-executive-assistant
 *   2. http-localhost-default
 *   3. uv-run-without-no-project-or-sync
 *   4. fs-write-outside-scratch
 *   5. vendor-docs-cron-collision
 *
 * Always scans the whole tracked `.ts` tree (there is no staged/--all
 * split like `check-trigger-logging.mjs` has): check 5 is inherently
 * cross-file (two DIFFERENT files collide with each other), so a
 * staged-files-only mode could never see the collision a given commit
 * introduces or fails to introduce. Scanning ~200 small files is well
 * under a second either way.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(__dirname, "hygiene-lint-baseline.json");

function run(cmd) {
  return execSync(cmd, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function listTrackedTsFiles() {
  const out = run('git ls-files "*.ts"');
  if (!out) return [];
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !p.endsWith(".d.ts"));
}

function readRel(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

/**
 * Naive comment stripping (block + line comments), same trade-off
 * `check-trigger-logging.mjs` accepts implicitly by using plain regexes: it
 * does not understand strings that happen to contain `//` or `/*`, but this
 * codebase's doc comments are large and would otherwise dominate every
 * rule's matches (e.g. rule 1 below would flag every file that so much as
 * *mentions* `getSecret()` in a doc comment, which is most of them).
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

/** @type {Array<{rule: string, key: string, detail: string}>} */
const allViolations = [];
const newViolations = [];

function record(rule, key, detail) {
  const violation = { rule, key, detail };
  allViolations.push(violation);
  const allowed = new Set(baseline[rule] ?? []);
  if (!allowed.has(key)) {
    newViolations.push(violation);
  }
}

const files = listTrackedTsFiles();
const fileText = new Map();
for (const relPath of files) {
  fileText.set(relPath, readFileSync(path.join(repoRoot, relPath), "utf8"));
}

// ---------------------------------------------------------------------------
// 1. getSecret-runtime-in-executive-assistant
// ---------------------------------------------------------------------------
/**
 * `executive-assistant`'s runtime env never has
 * `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` set (see
 * `executive-assistant/trigger.config.ts`'s `SYNCED_SECRETS` doc comment,
 * and `lib/require-env.ts`), unlike `watchdog`/`indb-blues`, which lean on
 * `getSecret()` at task-execution time throughout. A runtime `getSecret()`
 * call added to this project fails immediately (or silently degrades, if
 * wrapped in a `.catch()` nobody notices) — the fix is always
 * `trigger.config.ts`'s build-time `SYNCED_SECRETS` allowlist +
 * `requireSyncedEnv()` (see `lib/require-env.ts`), not a runtime fetch.
 */
function checkGetSecretInExecutiveAssistant() {
  const rule = "getSecret-runtime-in-executive-assistant";
  for (const [relPath, raw] of fileText) {
    if (!relPath.startsWith("executive-assistant/")) continue;
    if (relPath.endsWith(".test.ts")) continue;
    if (relPath === "executive-assistant/lib/require-env.ts") continue;
    const text = stripComments(raw);
    if (/\bgetSecret\s*\(/.test(text)) {
      record(rule, relPath, `${relPath}: runtime getSecret() call — executive-assistant has no Infisical creds at runtime, use requireSyncedEnv()+SYNCED_SECRETS instead`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. http-localhost-default
// ---------------------------------------------------------------------------
/**
 * A `process.env.X ?? "http://localhost:PORT"` fallback silently degrades a
 * production task to talking to itself instead of failing loudly when the
 * real URL env var is missing/misconfigured — the same class of bug
 * `require-env.ts`'s whole existence is fixing for secrets. Matches only an
 * actual nullish-coalescing (or `||`) DEFAULT value, not a doc-comment
 * example of a dev command (`stripComments` already drops those, and the
 * `??`/`||` requirement filters out plain mentions too).
 */
function checkLocalhostDefault() {
  const rule = "http-localhost-default";
  const re = /\?\?\s*["'`]http:\/\/localhost|\|\|\s*["'`]http:\/\/localhost/g;
  for (const [relPath, raw] of fileText) {
    if (relPath.endsWith(".test.ts")) continue;
    const text = stripComments(raw);
    if (re.test(text)) {
      record(rule, relPath, `${relPath}: process env fallback defaults to http://localhost — fails loudly instead, or document why the default is intentional`);
    }
    re.lastIndex = 0;
  }
}

// ---------------------------------------------------------------------------
// 3. uv-run-without-no-project-or-sync
// ---------------------------------------------------------------------------
/**
 * `runUv(dir, ["run", ..., "<script>.py", ...])` invoking a raw script path
 * (as opposed to an installed console-script entry point) against a freshly
 * cloned directory needs either:
 *   - `--no-project` (the pattern `domoDocsReport.ts`/`daily-standup.ts` use
 *     to run an ad-hoc script with only explicit `--with` deps, deliberately
 *     ignoring whatever `pyproject.toml` the cloned repo happens to have), or
 *   - a prior `runUv(dir, ["sync"])` in the same file (the pattern
 *     `crewRagDomoScrape.ts`/`bluesDropResearch.ts`/`deliver-discord.ts` use
 *     when the clone genuinely IS a uv-managed project and the task wants
 *     that project's own declared deps installed).
 * Neither present means the script runs inside whatever `uv` finds by
 * walking up from `dir` — including a `pyproject.toml`/`uv.lock` the CLONED
 * REPO controls, not this codebase, e.g. resolving arbitrary/unpinned deps
 * from a source outside this repo's review.
 */
function checkUvRunWithoutNoProject() {
  const rule = "uv-run-without-no-project-or-sync";
  for (const [relPath, raw] of fileText) {
    if (relPath.endsWith(".test.ts")) continue;
    if (relPath.endsWith("git-uv.ts")) continue; // defines runUv, doesn't call it
    const text = stripComments(raw);
    const callRe = /runUv\s*\(\s*[^,]+,\s*\[([^\]]*)\]/g;
    let match;
    let sawSync = false;
    let flagged = false;
    // First pass: does this file ever call runUv(dir, ["sync"]) at all?
    // (Coarser than "same dir" — matches this rule's own doc comment,
    // which only claims same-FILE precedent, not same-variable proof.)
    const syncRe = /runUv\s*\(\s*[^,]+,\s*\[\s*["']sync["']\s*\]/;
    sawSync = syncRe.test(text);

    while ((match = callRe.exec(text))) {
      const argsText = match[1];
      const hasRun = /["']run["']/.test(argsText);
      const hasRawScript = /["'][^"']*\.py["']/.test(argsText);
      const hasNoProject = /--no-project/.test(argsText);
      if (hasRun && hasRawScript && !hasNoProject && !sawSync) {
        flagged = true;
      }
    }
    if (flagged) {
      record(rule, relPath, `${relPath}: uv run of a raw .py script with neither --no-project nor a prior uv sync in this file`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. fs-write-outside-scratch
// ---------------------------------------------------------------------------
/**
 * Every filesystem write in this repo's tasks is meant to land under an
 * `os.tmpdir()`-rooted scratch dir (cleaned up after the run) or inside a
 * freshly `cloneRepo()`'d checkout the task owns for the run's lifetime —
 * never a fixed/shared location that would leak state between runs or
 * across the API/worker container boundary (see
 * `docs/project_notes/bugs.md`'s "API+worker no shared /tmp" entry for what
 * happens when that assumption breaks).
 *
 * Because this is a per-file text scan, not real dataflow analysis, "does
 * this path ultimately land under tmpdir" is approximated: the path
 * expression's leftmost identifier is resolved through same-file `const X =
 * ...` chains (up to 4 hops) looking for `tmpdir`/`scratch`/`mkdtemp`
 * anywhere in the chain; an identifier that resolves to a FUNCTION
 * PARAMETER instead of a local `const` is treated as the caller's
 * responsibility (out of scope for this file) and passes.
 */
function resolvesToScratch(text, ident, hopsLeft) {
  if (/tmpdir|scratch|mkdtemp/i.test(ident)) return true;
  if (hopsLeft <= 0) return false;

  const declRe = new RegExp(`const\\s+${ident}\\s*=([^;]*);`, "s");
  const declMatch = declRe.exec(text);
  if (!declMatch) {
    // No local `const` declaration found — either a function parameter
    // (caller's responsibility) or an identifier this scan can't resolve.
    // Treat as passing rather than risk noisy false positives.
    return true;
  }

  const rhs = declMatch[1];
  if (/tmpdir|scratch|mkdtemp/i.test(rhs)) return true;

  const nextIdentMatch = /([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rhs.replace(/^[^(]*\(/, ""));
  // Walk every identifier-looking token in the RHS, not just the first —
  // path.join(a, b) style calls can have the meaningful root as either arg
  // in this codebase's actual call shapes.
  const idents = rhs.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const candidate of idents) {
    if (candidate === ident) continue;
    if (["path", "join", "resolve", "os", "await", "fs", "process"].includes(candidate)) continue;
    if (resolvesToScratch(text, candidate, hopsLeft - 1)) return true;
  }
  void nextIdentMatch;
  return false;
}

function checkFsWriteOutsideScratch() {
  const rule = "fs-write-outside-scratch";
  const callRe = /\bfs\.(writeFile|writeFileSync|appendFile|mkdir|mkdirSync)\s*\(\s*([^,)]+)/g;
  for (const [relPath, raw] of fileText) {
    if (relPath.endsWith(".test.ts")) continue;
    const text = stripComments(raw);
    let match;
    let flagged = false;
    while ((match = callRe.exec(text))) {
      const argExpr = match[2].trim();
      if (/tmpdir|scratch|mkdtemp/i.test(argExpr)) continue;
      const rootIdent = (argExpr.match(/[A-Za-z_$][A-Za-z0-9_$]*/) ?? [])[0];
      if (!rootIdent) continue;
      if (!resolvesToScratch(text, rootIdent, 4)) {
        flagged = true;
      }
    }
    if (flagged) {
      record(rule, relPath, `${relPath}: a filesystem write does not resolve back to os.tmpdir()/scratch/mkdtemp within this file, and its root identifier is not a function parameter`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. vendor-docs-cron-collision
// ---------------------------------------------------------------------------
/**
 * Every `watchdog/src/trigger/vendor-docs/*.ts` source runs the same
 * mirror-then-ingest pipeline against a different upstream doc site.
 * Sharing a cron slot means those sources' clone/build/ingest work all lands
 * on the scheduler in the same minute — no correctness bug (each is an
 * independent scheduled task, not a shared resource), but it defeats the
 * whole reason nearby-but-distinct minutes were chosen in the first place
 * (spreading load so one slow/failing source's window doesn't overlap
 * another's), and makes a scheduler-level anomaly (e.g. a burst of load at
 * 09:00) harder to attribute to one misbehaving source.
 */
function checkVendorDocsCronCollision() {
  const rule = "vendor-docs-cron-collision";
  const dir = "watchdog/src/trigger/vendor-docs";
  /** @type {Map<string, string[]>} */
  const byPattern = new Map();
  for (const [relPath, raw] of fileText) {
    if (!relPath.startsWith(`${dir}/`)) continue;
    const text = stripComments(raw);
    const m = /pattern:\s*["']([^"']+)["']/.exec(text);
    if (!m) continue;
    const pattern = m[1];
    const arr = byPattern.get(pattern) ?? [];
    arr.push(relPath);
    byPattern.set(pattern, arr);
  }
  for (const [pattern, filesForPattern] of byPattern) {
    if (filesForPattern.length < 2) continue;
    record(
      rule,
      pattern,
      `cron slot "${pattern}" shared by ${filesForPattern.length} vendor-docs sources: ${filesForPattern.join(", ")}`
    );
  }
}

checkGetSecretInExecutiveAssistant();
checkLocalhostDefault();
checkUvRunWithoutNoProject();
checkFsWriteOutsideScratch();
checkVendorDocsCronCollision();

if (allViolations.length > 0) {
  console.log(`\nHygiene lint: ${allViolations.length} known/flagged instance(s) across 5 rules:\n`);
  for (const v of allViolations) {
    const isNew = newViolations.includes(v);
    console.log(`  [${v.rule}]${isNew ? " NEW" : " (baselined)"} ${v.detail}`);
  }
}

if (newViolations.length > 0) {
  console.error(
    `\nHygiene lint failed: ${newViolations.length} new violation(s) not in scripts/hygiene-lint-baseline.json.\n` +
      "Either fix them, or — if this is a deliberate, reviewed exception — add the key to the baseline file.\n"
  );
  process.exit(1);
}

console.log(
  allViolations.length > 0
    ? "\nHygiene lint passed (no NEW violations beyond the baseline)."
    : "Hygiene lint passed (no violations at all)."
);
