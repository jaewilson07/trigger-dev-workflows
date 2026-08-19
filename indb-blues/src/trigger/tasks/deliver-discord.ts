import { task, logger } from "@trigger.dev/sdk";
import { getSecret, runUv, pushWithAuth } from "@datacrew/trigger-shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  setupIndbWorkspace,
  BLUES_DROP_SCRIPT_REL_PATH,
  DROP_MANIFEST_REL_PATH,
} from "../../lib/indb-workspace.js";
import { bluesDropSkipped } from "../../lib/blues-drop-types.js";
import type { BluesDropResearch, BluesDropDeliveryOutcome } from "../../lib/blues-drop-types.js";

const execFileAsync = promisify(execFile);

/**
 * Discord delivery for the Blues Drop of the Week — the only destination
 * this issue wires (trigger-dev-workflows#98; #99 adds a second). Takes a
 * `BluesDropResearch` and knows nothing about how it was gathered, so it is
 * independently re-triggerable — a Discord outage doesn't cost the research
 * that already ran.
 *
 * Wraps `indb_discordbot`'s `blues_drop_artist_mode.py deliver`, which
 * itself wraps `upsert-post-to-discord/scripts/main.py forum` (the actually
 * generic Discord-posting entry point — see that script's module docstring
 * for why this is NOT `generate-drop-of-the-week/scripts/post_to_discord.py`,
 * despite the issue naming the latter).
 *
 * IDEMPOTENCY ACROSS SEPARATE RUNS. Each trigger.dev run clones a fresh,
 * throwaway checkout (same as `crewRagDomoScrape.ts`) — so a manifest write
 * inside that clone is invisible to the NEXT run unless committed and
 * pushed back to `indb_discordbot`'s `main` before the clone is discarded.
 * This task does that push itself (same `runGit`/`hasStagedChanges`/
 * `pushWithAuth` shape `crewRagDomoScrape.ts` uses for its own commit-back)
 * — without it, "reuse indb's existing manifest pattern" would look correct
 * in a single process and still duplicate-post on the next real trigger.dev
 * run, which is exactly the gap trigger-dev-workflows#98 asked to have
 * verified rather than assumed.
 */

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    const sanitized = new Error(
      `git ${args[0]} failed: ${(err.stderr || err.stdout || "no output captured").trim()}`
    ) as Error & { code?: number };
    if (typeof err.code === "number") sanitized.code = err.code;
    throw sanitized;
  }
}

async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ["diff", "--cached", "--quiet"]);
    return false;
  } catch (error) {
    if ((error as { code?: number }).code === 1) {
      return true;
    }
    throw error;
  }
}

type DeliverScriptOutcome = {
  status: "delivered" | "skipped";
  weekId: string;
  discordUrl?: string;
  threadId?: string;
  title?: string;
  reason?: string;
};

export const deliverDiscord = task({
  id: "deliver-discord",
  retry: { maxAttempts: 3 },
  maxDuration: 600,
  run: async (research: BluesDropResearch): Promise<BluesDropDeliveryOutcome> => {
    logger.info("starting deliver-discord", { weekId: research.weekId, topic: research.topic });

    const ghToken = await getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false });
    // BLUES_DISCORD_BOT_TOKEN is the name every consumer in indb_discordbot
    // reads (weekly-drop-flow/main.py, generate-drop-of-the-week/main.py,
    // bluescal_sync.py, upsert-post-to-discord/main.py's own fallback, ...)
    // but no Infisical secret with that exact name exists (verified
    // 2026-08-19: absent from a recursive listing of the whole homeserver
    // project). The real INDB bot token — confirmed live against
    // `GET /users/@me` (username "INDB") and against the forum channel
    // itself — is stored as IMDB_DISCORD_BOT_TOKEN, an evident typo never
    // fixed. Try the canonical name first so this self-heals if the typo is
    // ever corrected in Infisical; fall back to the actual (misnamed) key.
    let discordToken: string;
    try {
      discordToken = await getSecret("BLUES_DISCORD_BOT_TOKEN", { path: "/", recursive: true });
    } catch {
      discordToken = await getSecret("IMDB_DISCORD_BOT_TOKEN", { path: "/", recursive: true });
    }

    const workspace = await setupIndbWorkspace(ghToken, "blues-drop-deliver-");
    const researchFile = path.join(workspace.scratchRoot, "research.json");

    try {
      logger.info("running uv sync", { cwd: workspace.indbDir });
      await runUv(workspace.indbDir, ["sync"]);

      await fs.writeFile(researchFile, JSON.stringify(research));

      const result = await runUv(
        workspace.indbDir,
        ["run", "python", BLUES_DROP_SCRIPT_REL_PATH, "deliver", "--research-file", researchFile],
        {
          env: { ...process.env, DISCORD_BOT_TOKEN: discordToken },
          secrets: [discordToken],
        }
      );

      const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        throw new Error(`blues_drop_artist_mode.py deliver produced no output. stderr: ${result.stderr}`);
      }
      const outcome = JSON.parse(lastLine) as DeliverScriptOutcome;

      if (outcome.status === "skipped") {
        logger.info("deliver-discord: already synced, skipping", {
          weekId: outcome.weekId,
          reason: outcome.reason,
        });
        return bluesDropSkipped("discord", outcome.weekId, outcome.reason ?? "already synced");
      }

      // Commit + push the manifest update this delivery just wrote, so the
      // NEXT trigger.dev run (its own fresh clone) sees this week as synced.
      await runGit(workspace.indbDir, ["config", "user.name", "github-actions[bot]"]);
      await runGit(workspace.indbDir, [
        "config",
        "user.email",
        "github-actions[bot]@users.noreply.github.com",
      ]);
      await runGit(workspace.indbDir, ["add", DROP_MANIFEST_REL_PATH]);

      if (await hasStagedChanges(workspace.indbDir)) {
        await runGit(workspace.indbDir, [
          "commit",
          "-m",
          `chore: mark ${outcome.weekId} drop-of-the-week synced [skip ci]`,
        ]);
        await pushWithAuth(workspace.indbDir, "origin", "HEAD:main", ghToken);
        logger.info("deliver-discord: pushed manifest update", { weekId: outcome.weekId });
      } else {
        logger.warn("deliver-discord: delivered but manifest had no staged changes", {
          weekId: outcome.weekId,
        });
      }

      logger.info("deliver-discord: posted", {
        weekId: outcome.weekId,
        discordUrl: outcome.discordUrl,
      });

      if (!outcome.discordUrl || !outcome.threadId || !outcome.title) {
        throw new Error(
          `deliver-discord: script reported status "delivered" without discordUrl/threadId/title`
        );
      }

      return {
        destination: "discord",
        status: "delivered",
        weekId: outcome.weekId,
        discordUrl: outcome.discordUrl,
        threadId: outcome.threadId,
        title: outcome.title,
      };
    } finally {
      await workspace.cleanup();
    }
  },
});
