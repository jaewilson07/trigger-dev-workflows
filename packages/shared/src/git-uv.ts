import type { BuildExtension } from "@trigger.dev/build";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Shared git + uv tooling for trigger.dev workspace projects that need to
 * clone a private repo and run a `uv`-managed Python project at task
 * runtime (originally: watchdog's `crew-rag-domo-scrape`).
 *
 * Two call shapes, mirroring `infisical.ts`:
 *   - `gitAndUv()` — a build-time extension that bakes `uv` into the
 *     deployed image (git ships in every trigger.dev image already, see
 *     below, but is requested explicitly rather than relied on implicitly).
 *   - `cloneRepo()` / `runUv()` — runtime helpers that shell out via
 *     `execFile`, same pattern `watchdog/src/trigger/infraHealthReport.ts`
 *     already uses for `docker`/`infisical`/`letta`/`claude`.
 */

const execFileAsync = promisify(execFile);

/**
 * Build-time extension: installs `git` + `uv` into the deployed image.
 *
 * `git` is already present in every trigger.dev deploy image (it's in the
 * CLI's own `DEFAULT_PACKAGES` list, alongside `ca-certificates`), but it's
 * requested here explicitly anyway — a project that needs it to work should
 * not depend on an internal default it doesn't control.
 *
 * `uv` is not preinstalled anywhere, and there's no `apt` package for it.
 * The official installer (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
 * is a single self-contained script, so it's run as a **custom Dockerfile
 * `RUN` instruction** (`image.instructions`) rather than through the
 * `pkgs`-based `aptGet()` helper.
 *
 * This matters for ordering: the generated Containerfile runs
 * `image.instructions` in the `base` stage *before* the `image.pkgs`
 * apt-get install (see `trigger.dev`'s `buildImage.js` — `${baseInstructions}`
 * is emitted above the `apt-get install ${packages}` line), so a plain
 * `pkgs: ["curl"]` would not yet be on disk when an `instructions` RUN tried
 * to use it. The fix (same one `puppeteer()`'s bundled extension uses) is to
 * make the `curl`/`ca-certificates` install part of the *same* self-contained
 * RUN command as the thing that needs them, rather than relying on the
 * separate `pkgs` mechanism at all.
 *
 * `instructions` also runs in the `base` stage, which the final runtime
 * stage is built `FROM` — unlike `commands` (`layer.commands`), which only
 * runs later against `/app` in the `build` stage and would silently vanish
 * from the shipped image if used here, because the final stage does not
 * inherit anything outside `/app` from `build`. `UV_INSTALL_DIR=/usr/local/bin`
 * puts the binary somewhere already on `PATH` for exactly that reason —
 * `uv`'s own default (`$HOME/.local/bin`) is meaningless in a stage that
 * switches users and gets thrown away.
 */
export function gitAndUv(): BuildExtension {
  return {
    name: "git-and-uv",
    onBuildComplete(context) {
      if (context.target === "dev") {
        return;
      }

      context.logger.debug("Adding git+uv layer");

      context.addLayer({
        id: "git-and-uv",
        image: {
          pkgs: ["git"],
          instructions: [
            [
              "RUN apt-get update",
              "apt-get install -y --no-install-recommends curl ca-certificates",
              "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh",
              "rm -rf /var/lib/apt/lists/*",
            ].join(" \\\n  && "),
          ],
        },
      });
    },
  };
}

export type RunResult = {
  stdout: string;
  stderr: string;
};

/**
 * Writes a scoped `GIT_CONFIG_GLOBAL` file rewriting `https://github.com/`
 * to an authenticated URL, rather than embedding the token in the clone URL
 * argv (which would sit in plain sight in `ps`/process listings for the
 * life of the clone). Same technique used elsewhere in the org for PAT-gated
 * clones (`GIT_CONFIG_GLOBAL` + `url.<base>.insteadOf`).
 */
/**
 * Replaces every occurrence of `token` in `text` with a fixed placeholder.
 * Belt-and-suspenders alongside the `GIT_CONFIG_GLOBAL` rewrite itself:
 * empirically (auth failure, repo-not-found, and DNS-failure cases all
 * tested directly), git's own error text names the pre-rewrite URL, never
 * the credentialed one produced by an `insteadOf` rewrite — but "verified
 * for the failure modes tested" isn't "provably cannot happen for any git
 * version or transport error," and this guards a god-scope, all-repos PAT.
 */
function redactToken(text: string, token: string): string {
  return text.split(token).join("***REDACTED***");
}

async function withGitAuth<T>(
  token: string | undefined,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  if (!token) {
    return fn(process.env);
  }

  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-config-"));
  const configPath = path.join(configDir, "gitconfig");
  try {
    await fs.writeFile(
      configPath,
      `[url "https://x-access-token:${token}@github.com/"]\n\tinsteadOf = https://github.com/\n`,
      { mode: 0o600 }
    );
    try {
      return await fn({ ...process.env, GIT_CONFIG_GLOBAL: configPath });
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      const redacted = new Error(redactToken(err.message ?? String(error), token)) as Error & {
        stdout?: string;
        stderr?: string;
      };
      if (typeof err.stdout === "string") redacted.stdout = redactToken(err.stdout, token);
      if (typeof err.stderr === "string") redacted.stderr = redactToken(err.stderr, token);
      throw redacted;
    }
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
}

/**
 * Clones `url` into `dest`. `token` (a GitHub PAT) is optional — omit it for
 * public repos. Shallow (`--depth 1`): every current caller only needs a
 * fresh checkout to build/run from, not history, mirroring what
 * `actions/checkout` did in the GitHub Action this replaces.
 */
export async function cloneRepo(url: string, dest: string, token?: string): Promise<RunResult> {
  return withGitAuth(token, async (env) => {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["clone", "--depth", "1", url, dest],
      { env, maxBuffer: 1024 * 1024 * 10 }
    );
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  });
}

/**
 * Pushes `cwd`'s current branch to `remote refspec`, authenticated the same
 * way `cloneRepo` is (a scoped `GIT_CONFIG_GLOBAL` file, torn down
 * immediately after) rather than `git config --local url.<...>.insteadOf`
 * with the token embedded in that command's own argv — `execFile` surfaces
 * a failing command's full argv in `Error.message`, so a token passed that
 * way can end up in whatever logs the caller's error handler writes to.
 */
export async function pushWithAuth(
  cwd: string,
  remote: string,
  refspec: string,
  token: string
): Promise<RunResult> {
  return withGitAuth(token, async (env) => {
    const { stdout, stderr } = await execFileAsync("git", ["push", remote, refspec], {
      cwd,
      env,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  });
}

/** Runs `uv <args>` in `cwd`. Thin wrapper — same execFile pattern as the rest of the repo. */
export async function runUv(cwd: string, args: string[]): Promise<RunResult> {
  const { stdout, stderr } = await execFileAsync("uv", args, {
    cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
