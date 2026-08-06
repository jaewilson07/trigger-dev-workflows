/**
 * The one place this project shells out to the host.
 *
 * WHY THIS IS ITS OWN MODULE. Three of the health checks need host access
 * (`infisical`, `letta`, `claude`, `docker ps`) and nothing else in the project
 * does — so the checks that CAN'T run in a plain deployed container are exactly
 * the ones that go through here. Keeping that boundary visible is half the
 * point of the decomposition: before it, a `docker ps` failure degraded three
 * unrelated concerns to `"unknown"` in one code path.
 *
 * NEVER THROWS. A missing binary is a normal outcome in a container that has no
 * `docker` CLI, so the caller gets `{ ok: false, stderr }` and turns it into a
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** The compose file whose presence identifies the infra monorepo. */
const MONOREPO_MARKER = "infrastructure/bonker/infrastructure/docker-compose.yml";

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
