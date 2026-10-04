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

/**
 * Pinned `gh` (GitHub CLI) release, verified by sha256 against the upstream
 * `gh_<version>_checksums.txt` asset (`cli/cli` release `v2.101.0`, fetched
 * 2026-09-26 via `gh api repos/cli/cli/releases/tags/v2.101.0`). Bump both
 * together — an unmatched hash fails the build (`sha256sum -c`) rather than
 * silently installing a different binary than the one this pin names.
 */
const GH_CLI_VERSION = "2.101.0";
const GH_CLI_LINUX_AMD64_SHA256 =
  "9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8";

export type GitAndUvOptions = {
  /**
   * Also bakes the pinned `gh` CLI (see `GH_CLI_VERSION` above) into the
   * image, same layer/mechanism as `uv` below: a static release tarball,
   * downloaded and sha256-verified in one self-contained `RUN`, extracted
   * straight to `/usr/local/bin` (already on `PATH`). Off by default so
   * `watchdog`/`indb-blues` (the other current `gitAndUv()` callers) don't
   * pick up a binary they never asked for. `executive-assistant` passes
   * `{ gh: true }` — `tasks/assistant/daily-standup.ts` shells out to `gh`
   * for branch-protection/issue/PR data and must fail loudly, not silently
   * degrade, when it's missing (see that task's own comments).
   *
   * Auth at runtime is via `GH_TOKEN`/`GITHUB_TOKEN` env vars, which `gh`
   * reads natively — no `gh auth login` step needed; the task already sets
   * `GITHUB_TOKEN: ghPat` on the child-process env it runs the Python
   * scripts under.
   */
  gh?: boolean;
};

export function gitAndUv(options: GitAndUvOptions = {}): BuildExtension {
  const installGh = options.gh ?? false;

  return {
    name: "git-and-uv",
    onBuildComplete(context) {
      if (context.target === "dev") {
        return;
      }

      context.logger.debug("Adding git+uv layer", { gh: installGh });

      const ghInstructions = installGh
        ? [
            `curl -LsSf -o /tmp/gh.tar.gz https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz`,
            `echo "${GH_CLI_LINUX_AMD64_SHA256}  /tmp/gh.tar.gz" | sha256sum -c -`,
            "tar -xzf /tmp/gh.tar.gz -C /tmp",
            `install -m 0755 /tmp/gh_${GH_CLI_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh`,
            `rm -rf /tmp/gh.tar.gz /tmp/gh_${GH_CLI_VERSION}_linux_amd64`,
          ]
        : [];

      context.addLayer({
        id: "git-and-uv",
        image: {
          pkgs: ["git"],
          instructions: [
            [
              "RUN apt-get update",
              "apt-get install -y --no-install-recommends curl ca-certificates tar",
              "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh",
              ...ghInstructions,
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

export type RunUvOptions = {
  /** Overrides the child process env. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Values to redact from stdout/stderr on BOTH the success and failure
   * paths — a successful run's stdout can echo a secret just as easily as a
   * failing one's (e.g. the invoked program printing its own config/env on
   * startup), and `execFile`'s rejection separately echoes the full argv it
   * was called with (see `runGit`'s doc comment in `crewRagDomoScrape.ts` for
   * the same concern). Pass any secret the child process might see — as a
   * CLI flag or via `env` — here so it never round-trips into whatever the
   * caller logs (Trigger.dev's persisted run logs, in every current caller).
   */
  secrets?: string[];
};

function redactAll(text: string, secrets: string[]): string {
  return secrets.reduce(
    (acc, secret) => (secret ? acc.split(secret).join("***REDACTED***") : acc),
    text
  );
}

/** Runs `uv <args>` in `cwd`. Thin wrapper — same execFile pattern as the rest of the repo. */
export async function runUv(cwd: string, args: string[], opts: RunUvOptions = {}): Promise<RunResult> {
  const env = opts.env ?? process.env;
  const secrets = opts.secrets ?? [];
  try {
    const { stdout, stderr } = await execFileAsync("uv", args, {
      cwd,
      env,
      maxBuffer: 1024 * 1024 * 10,
    });
    return {
      stdout: secrets.length ? redactAll(stdout.trim(), secrets) : stdout.trim(),
      stderr: secrets.length ? redactAll(stderr.trim(), secrets) : stderr.trim(),
    };
  } catch (error) {
    if (secrets.length === 0) {
      throw error;
    }
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const redacted = new Error(redactAll(err.message ?? String(error), secrets)) as Error & {
      stdout?: string;
      stderr?: string;
    };
    if (typeof err.stdout === "string") redacted.stdout = redactAll(err.stdout, secrets);
    if (typeof err.stderr === "string") redacted.stderr = redactAll(err.stderr, secrets);
    throw redacted;
  }
}
