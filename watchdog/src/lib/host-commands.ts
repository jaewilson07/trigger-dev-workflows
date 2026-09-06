/**
 * The one place this project shells out to the host — or, since 2026-09-06,
 * talks to the Docker Engine API over HTTP.
 *
 * WHY THIS IS ITS OWN MODULE. Three of the health checks need host access
 * (`infisical`, `letta`, `claude`, `docker ps`) and nothing else in the project
 * does — so the checks that CAN'T run in a plain deployed container are exactly
 * the ones that go through here. Keeping that boundary visible is half the
 * point of the decomposition: before it, a `docker ps` failure degraded three
 * unrelated concerns to `"unknown"` in one code path.
 *
 * WHY `listContainers` USES HTTP AND NOT THE DOCKER CLI. The Trigger.dev task
 * container has no `docker` binary — the worker runs inside a container that
 * joins `ai-network` but has no Docker socket or CLI. The `docker-socket-proxy`
 * container IS on `ai-network` and exposes a guarded subset of the Docker Engine
 * API (`CONTAINERS=1`). So `fetch("http://docker-socket-proxy:2375/containers/json")`
 * works from inside the task container where `execFile("docker", ["ps", ...])`
 * does not. The CLI fallback remains for local `trigger dev` runs.
 *
 * NEVER THROWS. A missing binary or an unreachable API is a normal outcome in
 * a container, so the caller gets `{ ok: false, stderr }` and turns it into a
 * `"unknown"` check with a reason, rather than a crashed task.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type CommandResult = { ok: boolean; stdout: string; stderr: string };

export async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout?.trim() ?? "",
      stderr: err.stderr?.trim() ?? err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Docker container listing — HTTP API first, CLI fallback
// ---------------------------------------------------------------------------

/**
 * The Docker Engine API endpoint reachable from inside the Trigger.dev task
 * container. `docker-socket-proxy` is on `ai-network` and allows `CONTAINERS=1`.
 * Override with `DOCKER_API_URL` for a different setup.
 */
const DOCKER_API_URL = process.env.DOCKER_API_URL ?? "http://docker-socket-proxy:2375";

/** The shape we care about from `GET /containers/json`. */
type DockerContainer = { Names: string[]; State: string };

/**
 * Lists running container names via the Docker Engine API over HTTP.
 *
 * Falls back to `docker ps` CLI if the API is unreachable (e.g. local `trigger
 * dev` without docker-socket-proxy). NEVER THROWS — returns `{ ok: false, stderr }`
 * so the caller can produce an `unknown` row with a reason.
 */
export async function listContainers(): Promise<CommandResult> {
  // Try the HTTP API first — works from inside the Trigger.dev task container.
  try {
    const res = await fetch(`${DOCKER_API_URL}/containers/json`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, stdout: "", stderr: `Docker API returned HTTP ${res.status}` };
    }
    const containers = (await res.json()) as DockerContainer[];
    // `Names` is an array like `["/caddy"]` — strip the leading slash.
    const names = containers
      .filter((c) => c.State === "running")
      .map((c) => c.Names[0]?.replace(/^\//, "") ?? "")
      .filter(Boolean);
    return { ok: true, stdout: names.join("\n"), stderr: "" };
  } catch (apiError) {
    // API unreachable — fall through to CLI.
    const apiReason = apiError instanceof Error ? apiError.message : String(apiError);
  }

  // CLI fallback — works on the host or in a container with Docker installed.
  return runCommand("docker", ["ps", "--format", "{{.Names}}"]);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** The compose file whose presence identifies the infra monorepo. */
const MONOREPO_MARKER = "infrastructure/docker-compose.yml";

/**
 * Locates the infra monorepo on disk, or returns null.
 *
 * HONEST ABOUT BEING DEV-ONLY. This probes the filesystem, so in a deployed
 * task container it finds nothing and `check-repo-config-drift` reports
 * `"unknown"` with that as the reason — which the audit asked for explicitly
 * (R3): the previous version listed a hardcoded developer path
 * (`/home/jaewilson07/GitHub/simpleDiscordBot`) among its candidates, which
 * cannot exist in a container and made the check look configurable when it was
 * not. That candidate is gone; `INFRA_MONOREPO_ROOT` is now the only way to
 * point this at a real checkout, and the relative probes below only help a
 * local `trigger dev` run.
 *
 * Reading these files over an API instead — the other half of R3 — would make
 * the check work in a deployed container, but there is no such API today and
 * inventing one is a larger change than this rework. Documented rather than
 * silently half-done.
 */
export async function resolveRepoRoot(): Promise<string | null> {
  const configured = process.env.INFRA_MONOREPO_ROOT;
  const candidates = [configured, path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")].filter(
    (value): value is string => Boolean(value)
  );

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, MONOREPO_MARKER))) {
      return candidate;
    }
  }
  return null;
}

export async function readRepoFile(repoRoot: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

// ---------------------------------------------------------------------------
// Host-info HTTP endpoint — CLI versions + repo state from the host-info container
// ---------------------------------------------------------------------------

/**
 * The host-info service URL. The `host-info` container is on `ai-network` and
 * exposes CLI versions + infra repo git state via HTTP. This lets the watchdog
 * tasks get host-level info (infisical/letta/claude versions, repo branch/dirty
 * state) without having those binaries or the repo mounted in the task container.
 *
 * Override with `HOST_INFO_URL` for a different setup.
 */
const HOST_INFO_URL = process.env.HOST_INFO_URL ?? "http://host-info:8092";

/** The shape returned by GET /info on the host-info service. */
export type HostInfo = {
  clis: Record<string, string>;
  repo: {
    path: string;
    exists: boolean;
    branch: string;
    commit: string;
    dirty: boolean;
    dirty_files: string[];
  };
};

/**
 * Fetches host CLI versions and repo state from the host-info container.
 *
 * Falls back to null if the service is unreachable (e.g. local `trigger dev`
 * without the host-info container). NEVER THROWS.
 */
export async function fetchHostInfo(): Promise<HostInfo | null> {
  try {
    const res = await fetch(`${HOST_INFO_URL}/info`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as HostInfo;
  } catch {
    return null;
  }
}

/**
 * Reads a file from the infra repo via the host-info container's /file endpoint.
 *
 * Returns null if the service is unreachable. Throws if the file doesn't exist.
 * The path is relative to the infra repo root mounted in the host-info container.
 */
export async function fetchRepoFile(relativePath: string): Promise<string | null> {
  try {
    const url = `${HOST_INFO_URL}/file?path=${encodeURIComponent(relativePath)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
