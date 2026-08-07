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
 * Not a substitute for making the registry real — it turns a silent, day-long
 * outage into an immediate, explanatory failure. That is the whole claim.
 */

import { execSync } from "node:child_process";
import os from "node:os";

const REGISTRY = process.env.DOCKER_REGISTRY_URL ?? "localhost:5000";
const API = (process.env.TRIGGER_API_URL ?? "").replace(/\/+$/, "");

function die(lines) {
  console.error("\n✖ Deploy preflight failed\n");
  for (const l of lines) console.error("  " + l);
  console.error("");
  process.exit(1);
}

const problems = [];

// 1. The registry must be reachable from here, or the image has nowhere to go
//    that the supervisor can read.
let registryOk = false;
try {
  execSync(`curl -sf --max-time 5 -o /dev/null http://${REGISTRY}/v2/ -w '%{http_code}'`, {
    stdio: "pipe",
  });
  registryOk = true;
} catch {
  // curl exits non-zero on connection failure AND on 401. A 401 means the
  // registry is *there* and simply wants auth — that is reachable, which is
  // all we are testing. Distinguish them.
  try {
    const code = execSync(
      `curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://${REGISTRY}/v2/ || true`,
      { encoding: "utf8" }
    ).trim();
    registryOk = code !== "000" && code !== "";
  } catch {
    registryOk = false;
  }
}

if (!registryOk) {
  // os.hostname() rather than shelling out — `hostname` is not guaranteed on
  // a minimal image, and an empty name made the error read "not reachable
  // from ." which tells the reader nothing.
  const host = os.hostname() || "this host";
  problems.push(
    `The registry \`${REGISTRY}\` is not reachable from ${host}.`,
    "",
    "A deploy from here would build the image locally, report success, and",
    "register a version the worker can never pull — the exact failure that",
    "took the daily brief down for ~24h on 2026-08-06.",
    "",
    "Deploy from the host that runs the Trigger.dev worker (bonker), or give",
    "the registry an address every host can resolve and set DOCKER_REGISTRY_URL",
    "to it.",
    "",
    "Override only if you know why:  SKIP_DEPLOY_PREFLIGHT=1"
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

if (problems.length > 0 && !process.env.SKIP_DEPLOY_PREFLIGHT) die(problems);
if (problems.length > 0) {
  console.warn("\n⚠ Deploy preflight problems ignored via SKIP_DEPLOY_PREFLIGHT:\n");
  for (const p of problems) console.warn("  " + p);
  console.warn("");
}

console.log(`✔ Deploy preflight passed — registry ${REGISTRY} reachable from this host.`);
