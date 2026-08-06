#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const allFiles = args.has("--all");
const stagedOnly = !allFiles;

function run(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function getCandidateFiles() {
  if (stagedOnly) {
    const out = run("git diff --cached --name-only --diff-filter=ACMR");
    if (!out) return [];
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  const out = run("git ls-files \"*.ts\"");
  if (!out) return [];
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function isTaskFile(text, relPath) {
  if (!relPath.endsWith(".ts")) return false;
  if (relPath.endsWith(".d.ts")) return false;
  if (relPath.includes("node_modules/")) return false;
  if (relPath.endsWith("trigger.config.ts")) return false;
  if (relPath.includes("/lib/")) return false;

  // Must use Trigger SDK + declare at least one task/schedule/schemaTask.
  const usesTriggerSdk = /from\s+["']@trigger\.dev\/sdk["']/.test(text);
  const declaresTask = /\b(task|schemaTask|schedules\.task)\s*\(/.test(text);
  return usesTriggerSdk && declaresTask;
}

function hasDisabledDirective(text) {
  return /trigger-log-lint:\s*disable/.test(text);
}

function hasLoggerImport(text) {
  // Covers: import { task, logger } from "@trigger.dev/sdk";
  return /import\s*\{[^}]*\blogger\b[^}]*\}\s*from\s*["']@trigger\.dev\/sdk["']/.test(text);
}

function countLoggerCalls(text) {
  const matches = text.match(/\blogger\.(info|warn|error|debug)\s*\(/g);
  return matches ? matches.length : 0;
}

function hasLifecycleMarkers(text) {
  // Keep this permissive: we only require one start-ish and one end-ish marker.
  const startish = /logger\.(info|debug)\s*\(\s*["'`][^"'`]*(start|starting|begin|launch|triggering|running)[^"'`]*["'`]/i.test(text);
  const endish = /logger\.(info|warn|error)\s*\(\s*["'`][^"'`]*(done|complete|completed|failed|error|finished|success)[^"'`]*["'`]/i.test(text);
  return { startish, endish };
}

const files = getCandidateFiles();
const failures = [];

for (const relPath of files) {
  const abs = path.resolve(relPath);
  if (!existsSync(abs)) continue;

  const text = readFileSync(abs, "utf8");
  if (!isTaskFile(text, relPath)) continue;
  if (hasDisabledDirective(text)) continue;

  const loggerImport = hasLoggerImport(text);
  const loggerCalls = countLoggerCalls(text);
  const { startish, endish } = hasLifecycleMarkers(text);

  const fileErrors = [];
  if (!loggerImport) {
    fileErrors.push("missing logger import from @trigger.dev/sdk");
  }
  if (loggerCalls < 2) {
    fileErrors.push("expected at least 2 logger calls (start + terminal outcome)");
  }
  if (!startish) {
    fileErrors.push("missing start marker log message (e.g. 'starting ...')");
  }
  if (!endish) {
    fileErrors.push("missing terminal marker log message (e.g. 'completed ...' or 'failed ...')");
  }

  if (fileErrors.length > 0) {
    failures.push({ relPath, fileErrors });
  }
}

if (failures.length > 0) {
  console.error("\nTrigger logging consistency check failed:\n");
  for (const f of failures) {
    console.error(`- ${f.relPath}`);
    for (const err of f.fileErrors) {
      console.error(`  - ${err}`);
    }
  }
  console.error("\nFix the logging shape or add 'trigger-log-lint: disable' with justification in file comments.");
  process.exit(1);
}

console.log(`Trigger logging consistency check passed (${stagedOnly ? "staged" : "all"} files).`);
