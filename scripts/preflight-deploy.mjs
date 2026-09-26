#!/usr/bin/env node
/**
 * Refuse a deploy that would produce an unrunnable deployment.
 *
 * THE FAILURE THIS PREVENTS. The self-hosted webapp hands every deploy
 * `DOCKER_REGISTRY_URL=localhost:5000`. That string means a different machine
 * depending on where the CLI runs, and nothing in the deploy path notices:
 *
 *   - on bonker  -> bonker's registry/daemon, the supervisor finds the image
 *   - anywhere else -> that host's own localhost, image never leaves
 *
 * On 2026-08-06 a deploy ran from cubby. It reported success, the webapp
 * recorded the new version as current, and the image stayed on cubby. Every
 * run from then on targeted a version with no image, sat QUEUED forever, and
 * never failed — so no alert could fire. The daily brief silently stopped for
 * ~24h.
 *
 * The deploy reporting success is the whole problem: `trigger deploy` verifies
 * that it built and registered, not that the worker can obtain the result. This
 * closes that gap by checking, before the build, that the registry the image is
 * destined for is actually reachable from *this* host.
 *
 * POLICY: deploys run on bonker, exclusively. The CLI uses `--local-build`,
 * which imports the image straight into whatever docker daemon it is talking
 * to — the registry is never in the path (it has never held a layer). So the
 * deploy host IS the delivery mechanism: build on the host whose daemon the
 * supervisor pulls from, or the image is stranded. That is not a preference,
 * it is how local-build works.
 *
 * This checks the policy directly rather than probing the registry, because a
 * registry probe only *correlates* with being on the right host. Set
 * TRIGGER_DEPLOY_HOSTS to change the allowlist.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

const REGISTRY = process.env.DOCKER_REGISTRY_URL ?? "localhost:5000";
const API = (process.env.TRIGGER_API_URL ?? "").replace(/\/+$/, "");
const ALLOWED_HOSTS = (process.env.TRIGGER_DEPLOY_HOSTS ?? "bonker")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function die(lines) {
  console.error("\n✖ Deploy preflight failed\n");
  for (const l of lines) console.error("  " + l);
  console.error("");
  process.exit(1);
}

const problems = [];

// 1. Deploy host policy — the load-bearing check.
const HOST = (os.hostname() || "").split(".")[0].toLowerCase();

if (!ALLOWED_HOSTS.includes(HOST)) {
  problems.push(
    `Deploys must run on: ${ALLOWED_HOSTS.join(", ")}. This is ${HOST || "an unknown host"}.`,
    "",
    "The CLI uses --local-build, so the image is imported into THIS host's",
    "docker daemon and never pushed anywhere. Deploying from the wrong host",
    "produces a version the Trigger.dev worker can never pull: runs sit QUEUED",
    "forever at attemptCount 0, never FAIL, and no alert fires.",
    "",
    "That is what happened on 2026-08-06 — a deploy from cubby took the daily",
    "brief down for ~24h before anyone noticed.",
    "",
    `  ssh ${ALLOWED_HOSTS[0]} 'cd ~/GitHub/trigger-dev-workflows && npm run deploy:executive-assistant'`,
    "",
    "Override only if you know why:  SKIP_DEPLOY_PREFLIGHT=1"
  );
}

// 2. Registry reachability — a secondary check on the same underlying fact.
//    Kept because it catches a right-host-but-broken-registry case that the
//    hostname check alone would wave through.
let registryOk = false;
try {
  const code = execSync(
    `curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://${REGISTRY}/v2/ || true`,
    { encoding: "utf8" }
  ).trim();
  // A 401 means the registry is there and wants auth — reachable, which is all
  // this tests. 000 means nothing answered.
  registryOk = code !== "000" && code !== "";
} catch {
  registryOk = false;
}

if (ALLOWED_HOSTS.includes(HOST) && !registryOk) {
  problems.push(
    `On ${HOST} (an approved deploy host) but \`${REGISTRY}\` did not answer.`,
    "The registry container may be down. Check: docker ps --filter name=registry"
  );
}

// 2. An empty project ref silently becomes "" in trigger.config.ts and dies
//    later as a confusing 404 on /api/v1/projects//prod.
if (!process.env.TRIGGER_PROJECT_REF) {
  problems.push(
    "TRIGGER_PROJECT_REF is not set. trigger.config.ts falls back to \"\", which",
    "fails deep in the CLI as `No route matches URL \"/api/v1/projects//prod\"`."
  );
}

if (!process.env.TRIGGER_ACCESS_TOKEN) {
  problems.push("TRIGGER_ACCESS_TOKEN is not set — the CLI cannot authenticate.");
}

if (API && !API.startsWith("https://")) {
  problems.push(`TRIGGER_API_URL is "${API}" — expected an https:// URL.`);
}

// 5. cloneRepo()/runUv() tasks — jaewilson07/trigger-dev-workflows#206, item
//    3. `crewRagDomoScrape.ts` (watchdog), `daily-standup.ts`
//    (executive-assistant), and every indb-blues task under `tasks/` clone a
//    repo at RUNTIME and run `uv` against it — inside the DEPLOYED
//    CONTAINER, whose image `trigger.config.ts`'s `gitAndUv()` build
//    extension bakes `git`/`uv` into. That build extension runs on THIS
//    host (deploys are `--local-build`, per the policy above), so if `git`
//    or `uv` aren't even resolvable here, the image build step that's
//    supposed to install them is standing on ground that's already broken
//    — the same class of "reports success, then everything downstream
//    silently fails" gap the load-bearing check above exists for, just one
//    layer earlier. Only runs for a workspace whose OWN tracked source
//    actually calls `cloneRepo(`/`runUv(` — watchdog's vendor-docs sources
//    (a different code path, `runGit`/mirror helpers, not `runUv`) don't
//    need `uv` at all, for instance.
const workspaceArg = process.argv[2];
const CLONE_UV_WORKSPACES = workspaceArg
  ? [workspaceArg]
  : ["watchdog", "executive-assistant", "indb-blues"];

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listWorkspaceTsFiles(workspace) {
  const out = execSync(`git ls-files "${workspace}/**/*.ts"`, { encoding: "utf8" }).trim();
  if (!out) return [];
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !p.endsWith(".d.ts") && !p.endsWith(".test.ts"));
}

/** Best-effort: resolves a `cloneRepo(IDENT, ...)` call's first argument back
 * to a string literal via a same-file `const IDENT = "...";` (or a template
 * literal with no `${}` interpolation). Returns null rather than guessing
 * when the URL is built dynamically (e.g. `vendorDocsMirror.ts`'s per-source
 * `upstreamUrl` — not every cloneRepo target is a fixed value). */
function resolveCloneUrls(text) {
  const urls = new Set();
  const callRe = /cloneRepo\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*|["'`][^"'`]*["'`])/g;
  let match;
  while ((match = callRe.exec(text))) {
    const arg = match[1];
    if (/^["'`]/.test(arg)) {
      urls.add(arg.slice(1, -1));
      continue;
    }
    const declRe = new RegExp(`const\\s+${arg}\\s*=\\s*["'\`]([^"'\`$]*)["'\`]`);
    const declMatch = declRe.exec(text);
    if (declMatch) urls.add(declMatch[1]);
  }
  return urls;
}

let anyWorkspaceUsesCloneUv = false;
const cloneUrls = new Set();
for (const workspace of CLONE_UV_WORKSPACES) {
  let usesCloneOrUv = false;
  for (const relPath of listWorkspaceTsFiles(workspace)) {
    const text = stripComments(readFileSync(relPath, "utf8"));
    if (/\bcloneRepo\s*\(|\brunUv\s*\(/.test(text)) {
      usesCloneOrUv = true;
      for (const url of resolveCloneUrls(text)) cloneUrls.add(url);
    }
  }
  if (usesCloneOrUv) anyWorkspaceUsesCloneUv = true;
}

if (anyWorkspaceUsesCloneUv) {
  for (const [bin, hint] of [
    ["git", "apt-get install -y git (or check trigger.config.ts's gitAndUv() build extension)"],
    ["uv", "curl -LsSf https://astral.sh/uv/install.sh | sh (see git-uv.ts's own installer for the pinned equivalent)"],
  ]) {
    try {
      execSync(`${bin} --version`, { stdio: "pipe" });
    } catch {
      problems.push(
        `\`${bin}\` is not runnable on this host, but a task in ${CLONE_UV_WORKSPACES.join("/")} ` +
          `clones a repo and runs \`uv\` against it at runtime — deploying builds that task's ` +
          "image on THIS host (--local-build), so if the toolchain the build extension needs " +
          "isn't even resolvable here, the deploy will report success and every run of that " +
          "task will fail or silently degrade the moment it tries to clone.",
        `  Fix: ${hint}`
      );
    }
  }

  // Opt-in, network-touching, and deliberately never a hard failure: a
  // stale/renamed/deleted clone target, or an expired token this host
  // doesn't have configured, shouldn't block every OTHER deploy. This is a
  // "does the URL still resolve" sanity dry-run, not an auth probe — a
  // private repo failing here with no token configured on this host is
  // expected and not itself informative.
  if (process.env.TRIGGER_DEPLOY_CHECK_CLONE_URLS === "1" && cloneUrls.size > 0) {
    console.log(`\nChecking ${cloneUrls.size} clone target(s) resolve (TRIGGER_DEPLOY_CHECK_CLONE_URLS=1)...`);
    for (const url of cloneUrls) {
      try {
        execSync(`git ls-remote --exit-code "${url}" HEAD`, {
          stdio: "pipe",
          timeout: 10_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        console.log(`  ✔ ${url}`);
      } catch {
        console.warn(`  ⚠ ${url} did not resolve (may just mean no token is configured on this host)`);
      }
    }
  }
}

if (problems.length > 0 && !process.env.SKIP_DEPLOY_PREFLIGHT) die(problems);
if (problems.length > 0) {
  console.warn("\n⚠ Deploy preflight problems ignored via SKIP_DEPLOY_PREFLIGHT:\n");
  for (const p of problems) console.warn("  " + p);
  console.warn("");
}

console.log(`✔ Deploy preflight passed — ${HOST} is an approved deploy host, ${REGISTRY} reachable.`);
