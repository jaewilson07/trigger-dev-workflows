import { task, logger } from "@trigger.dev/sdk";
import { getSecret, cloneRepo, pushWithAuth } from "@datacrew/trigger-shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderBluesDropPage, bluesDropWebUrl } from "../../lib/blues-drop-web.js";
import { bluesDropSkipped } from "../../lib/blues-drop-types.js";
import type { BluesDropResearch, BluesDropDeliveryOutcome } from "../../lib/blues-drop-types.js";

const execFileAsync = promisify(execFile);
const INDB_REPO_URL = "https://github.com/jaewilson07/indb_discordbot.git";

/**
 * Web delivery for the Blues Drop of the Week — the THIRD destination
 * (trigger-dev-workflows#111; #98 was Discord, #99 Notion). Publishes a
 * styled static page (`lib/blues-drop-web.ts`) to `indb_discordbot`'s
 * `gh-pages` orphan branch — deliberately NOT `main`, and NOT sourced from
 * `/docs` (that tree carries internal architecture notes never meant to be
 * public; the orphan branch starts empty and only ever contains what this
 * task explicitly writes).
 *
 * SIMPLER RETRY STORY THAN DISCORD'S. `deliver-discord` treats its manifest
 * push as best-effort because a retry re-runs the WHOLE task body, including
 * the (already-irreversible) Discord post — a push failure there must not
 * become a thrown error or Trigger.dev's retry would duplicate-post. This
 * task has no such risk: writing `drops/{weekId}/index.html` is a pure
 * overwrite, so re-running it (whether from a retry or a deliberate
 * re-delivery) just republishes identical or updated content — never a
 * duplicate. A push failure here is allowed to throw and retry normally.
 *
 * BUILDS ON THE REAL EXISTING gh-pages TIP, NOT AN ORPHAN CHECKOUT EVERY
 * RUN. `cloneRepo()` only ever clones the repo's default branch
 * (`main`) — see its own doc comment — so this task fetches `gh-pages`
 * separately, replicating `git-uv.ts`'s scoped-`GIT_CONFIG_GLOBAL` auth
 * technique for that one extra fetch (`withGitAuth` itself isn't exported).
 * First-ever run (no `gh-pages` branch yet) falls back to `--orphan`. Every
 * later run branches from the real fetched tip and pushes a genuine
 * fast-forward, so every previously published week's page survives.
 */

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: env ?? process.env,
      maxBuffer: 1024 * 1024 * 10,
    });
    return stdout.trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.stdout || String(error)).trim()}`);
  }
}

/**
 * Mirrors `git-uv.ts`'s private `withGitAuth` for the one operation this
 * task needs that `cloneRepo`/`pushWithAuth` don't cover: fetching a
 * non-default branch. Same technique (scoped `GIT_CONFIG_GLOBAL`
 * `insteadOf` rewrite, torn down immediately after) so a leaked token risk
 * doesn't get reintroduced by hand-rolling something weaker.
 */
async function fetchBranchAuthed(cwd: string, branch: string, token: string): Promise<void> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-config-"));
  const configPath = path.join(configDir, "gitconfig");
  try {
    await fs.writeFile(
      configPath,
      `[url "https://x-access-token:${token}@github.com/"]\n\tinsteadOf = https://github.com/\n`,
      { mode: 0o600 }
    );
    await runGit(cwd, ["fetch", "--depth", "1", "origin", branch], {
      ...process.env,
      GIT_CONFIG_GLOBAL: configPath,
    });
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
}

/** Lists `drops/*` directories present in the checked-out gh-pages tree and
 * rewrites the root `index.html` as a simple archive redirecting to (and
 * linking) the newest week — plain HTML, no JS, no build step. */
async function regenerateArchiveIndex(ghPagesDir: string): Promise<void> {
  const dropsDir = path.join(ghPagesDir, "drops");
  let weekIds: string[] = [];
  try {
    const entries = await fs.readdir(dropsDir, { withFileTypes: true });
    weekIds = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  } catch {
    weekIds = [];
  }
  const latest = weekIds[0];
  const items = weekIds
    .map((w) => `      <li><a href="drops/${w}/">${w}</a></li>`)
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${latest ? `<meta http-equiv="refresh" content="0; url=drops/${latest}/">` : ""}
<title>Blues Music Drops</title>
</head>
<body>
${latest ? `<p>Redirecting to the latest drop… <a href="drops/${latest}/">Blues Music Drops — Week ${latest}</a></p>` : "<p>No drops published yet.</p>"}
${items ? `<ul>\n${items}\n    </ul>` : ""}
</body>
</html>
`;
  await fs.writeFile(path.join(ghPagesDir, "index.html"), html);
}

export type DeliverWebPayload = {
  research: BluesDropResearch;
  /** Set by `bluesDropDeliver` if Discord's post already resolved by the
   * time this ran — purely a nice-to-have cross-link on the page itself;
   * this task's own delivery never depends on it. */
  discordUrl?: string;
  /** `false` returns `skipped` without publishing — matches `deliver-notion`'s
   * `enabled` convention. */
  enabled?: boolean;
};

export const deliverWeb = task({
  id: "deliver-web",
  retry: { maxAttempts: 2 },
  maxDuration: 300,
  run: async (payload: DeliverWebPayload): Promise<BluesDropDeliveryOutcome> => {
    const { research } = payload;
    logger.info("starting deliver-web", { weekId: research.weekId, topic: research.topic });

    if (payload.enabled === false) {
      return bluesDropSkipped("web", research.weekId, "disabled by caller");
    }

    const ghToken = await getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false });
    const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blues-drop-deliver-web-"));
    const repoDir = path.join(scratchRoot, "indb_discordbot");

    try {
      await cloneRepo(INDB_REPO_URL, repoDir, ghToken);

      // Only "the branch genuinely doesn't exist yet" falls back to
      // `--orphan` — any OTHER fetch failure (network blip, auth hiccup)
      // rethrows and lets this task's own retry handle it. Conflating the
      // two would be dangerous: a transient failure treated as "start
      // fresh" builds an orphan branch with no relation to the real
      // history, and while the later `pushWithAuth` push would be
      // correctly REJECTED (non-fast-forward) rather than silently
      // clobbering prior weeks, that's still a wasted, confusing retry
      // instead of the fetch just succeeding the second time.
      let hasRemoteGhPages = true;
      try {
        await fetchBranchAuthed(repoDir, "gh-pages", ghToken);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/couldn't find remote ref|not found in upstream/i.test(message)) {
          throw error;
        }
        hasRemoteGhPages = false;
      }

      if (hasRemoteGhPages) {
        await runGit(repoDir, ["checkout", "-B", "gh-pages", "FETCH_HEAD"]);
      } else {
        logger.info("deliver-web: no gh-pages branch yet, starting one", { weekId: research.weekId });
        await runGit(repoDir, ["checkout", "--orphan", "gh-pages"]);
        await runGit(repoDir, ["rm", "-rf", "--quiet", "."]);
      }

      const pageDir = path.join(repoDir, "drops", research.weekId);
      await fs.mkdir(pageDir, { recursive: true });
      const html = renderBluesDropPage(research, { discordUrl: payload.discordUrl });
      await fs.writeFile(path.join(pageDir, "index.html"), html);
      await regenerateArchiveIndex(repoDir);

      await runGit(repoDir, ["config", "user.name", "github-actions[bot]"]);
      await runGit(repoDir, [
        "config",
        "user.email",
        "github-actions[bot]@users.noreply.github.com",
      ]);
      await runGit(repoDir, ["add", "-A"]);

      let hasChanges = true;
      try {
        await runGit(repoDir, ["diff", "--cached", "--quiet"]);
        hasChanges = false;
      } catch {
        hasChanges = true;
      }

      const title = `${research.topic} — Blues Music Drops`;
      const url = bluesDropWebUrl(research.weekId);

      if (!hasChanges) {
        logger.info("deliver-web: page already up to date, nothing to publish", {
          weekId: research.weekId,
        });
        return { destination: "web", status: "delivered", weekId: research.weekId, url, title };
      }

      await runGit(repoDir, ["commit", "-m", `chore: publish ${research.weekId} drop page [skip ci]`]);
      await pushWithAuth(repoDir, "origin", "HEAD:gh-pages", ghToken);

      logger.info("deliver-web: published", { weekId: research.weekId, url });

      return { destination: "web", status: "delivered", weekId: research.weekId, url, title };
    } finally {
      await fs.rm(scratchRoot, { recursive: true, force: true });
    }
  },
});
