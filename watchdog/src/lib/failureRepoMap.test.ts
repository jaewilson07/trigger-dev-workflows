import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getOwningRepo, MONITORED_PROJECTS } from "./failureRepoMap.js";

/**
 * Coverage test: enumerate every task id actually exported by the three
 * monitored projects' source, and assert `getOwningRepo` resolves each one
 * (to an override or the default — either is fine, but it must resolve). A
 * new task file that adds a `task({ id: "..." })` can't silently go
 * unrepresented in the map's universe, per #206's "so a new task can't slip
 * through".
 *
 * This walks the SOURCE TREE, not the compiled/bundled output — it only
 * needs to run in this workspace's own `node --test` pass (never at task
 * runtime, where the bundled image may not even have separate .ts files on
 * disk), so it locates the repo root from `process.cwd()` rather than
 * assuming a fixed relative depth.
 */

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "trigger-dev-workflows") return dir;
      } catch {
        // not JSON, or unreadable — keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `findRepoRoot: could not find the trigger-dev-workflows repo root above ${startDir}`
  );
}

function walkTsFiles(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".trigger" || entry.startsWith(".")) continue;
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      walkTsFiles(p, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Matches `<anything>({ id: "task-id"` — every hand-written task
 * (`task(`/`schemaTask(`/`schedules.task(`) AND every factory-built one
 * (`createPatternHunterStepTask(`) follow the same convention: `id` is the
 * literal first property of the object literal passed to the call. Dynamic
 * ids (`id: config.id`, `id: String(i)`, `id: \`hit-${i}\``) don't match —
 * intentionally, since those aren't a registerable task id.
 */
const ID_RE = /\(\s*\{\s*\n?\s*id:\s*"([a-z][a-z0-9-]*)"/g;

function enumerateTaskIds(projectDir: string): string[] {
  const ids: string[] = [];
  for (const file of walkTsFiles(projectDir, [])) {
    const text = readFileSync(file, "utf8");
    ID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ID_RE.exec(text))) {
      ids.push(m[1]);
    }
  }
  return ids;
}

const PROJECT_SOURCE_DIRS: Record<string, string> = {
  watchdog: "watchdog/src",
  "executive-assistant": "executive-assistant",
  "indb-blues": "indb-blues/src",
};

test("getOwningRepo resolves every task id currently declared in each monitored project", () => {
  const root = findRepoRoot(process.cwd());
  let totalChecked = 0;

  for (const { key } of MONITORED_PROJECTS) {
    const sourceDir = PROJECT_SOURCE_DIRS[key];
    assert.ok(sourceDir, `no source dir configured for monitored project "${key}"`);

    const ids = enumerateTaskIds(path.join(root, sourceDir));
    assert.ok(
      ids.length > 0,
      `enumerated zero task ids for "${key}" under ${sourceDir} — enumeration regex likely broke`
    );

    for (const id of ids) {
      const repo = getOwningRepo(key, id);
      assert.ok(
        typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo),
        `getOwningRepo("${key}", "${id}") returned an invalid repo: ${JSON.stringify(repo)}`
      );
    }
    totalChecked += ids.length;
  }

  // Sanity floor so a future refactor that hollows out the enumeration (e.g.
  // an accidental early return) still gets caught even if some individual
  // project's dir check above is skipped for some reason.
  assert.ok(
    totalChecked >= 50,
    `expected at least 50 task ids across all monitored projects, found ${totalChecked}`
  );
});

test("getOwningRepo: explicit overrides resolve to the expected repo", () => {
  assert.equal(getOwningRepo("watchdog", "crew-rag-domo-scrape"), "hector-dcs/crew-rag-domo");
  assert.equal(getOwningRepo("watchdog", "domo-docs-report"), "jaewilson07/datacrew");
  assert.equal(getOwningRepo("watchdog", "domo-community-journal"), "jaewilson07/datacrew");
  assert.equal(getOwningRepo("watchdog", "slack-community-journal"), "jaewilson07/datacrew");
});

test("getOwningRepo: unknown task id falls back to this repo, scoped per project", () => {
  assert.equal(
    getOwningRepo("executive-assistant", "some-brand-new-task"),
    "jaewilson07/trigger-dev-workflows"
  );
  assert.equal(
    getOwningRepo("indb-blues", "another-new-task"),
    "jaewilson07/trigger-dev-workflows"
  );
  // Same task id, different project — an override on one project's id must
  // not leak onto the same id in another project.
  assert.equal(
    getOwningRepo("indb-blues", "crew-rag-domo-scrape"),
    "jaewilson07/trigger-dev-workflows"
  );
});
