import { task, logger, tags } from "@trigger.dev/sdk";
import { getSecret, runUv } from "@datacrew/trigger-shared";
import { setupIndbWorkspace, BLUES_DROP_SCRIPT_REL_PATH } from "../lib/indb-workspace.js";
import type { BluesDropResearch } from "../lib/blues-drop-types.js";

/**
 * The RESEARCH half of the Blues Drop of the Week
 * (`docs/ADR-002-research-seam-delivery-composition.md`): resolves this
 * week's artist-mode topic and Spotify-matches it, returning a
 * `BluesDropResearch` that knows no destination.
 *
 * All of the actual work happens in `indb_discordbot`'s own
 * `blues_drop_artist_mode.py research` — invoked via the `git-uv`
 * clone-then-`uv run` pattern already live-verified for watchdog's
 * `crew-rag-domo-scrape` (`crewRagDomoScrape.ts`). That script resolves the
 * topic (round-robin over a curated "prolific artist" backlog, deterministic
 * on the ISO week number) and Spotify-matches it via the existing,
 * unmodified `curate-bma-nominees` runbook — this task does not
 * reimplement either.
 */
async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    console.warn(
      "Skipping Trigger.dev tags outside managed runtime:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** No caller currently passes anything — the topic is always resolved
 * internally from the ISO week number, not from the payload. Typed (rather
 * than omitted) so `triggerAndWait({})` call sites match every other
 * research task in this repo (`infraHealthResearch`, `crewRagDomoScrape`). */
export type BluesDropResearchPayload = Record<string, never>;

export const bluesDropResearch = task({
  id: "blues-drop-research",
  // The child `uv run` does the retry-worthy work (Spotify API calls); a
  // couple of attempts here covers a transient clone/sync failure without
  // masking a genuine bug behind endless retries.
  retry: { maxAttempts: 2 },
  maxDuration: 600,
  run: async (_payload: BluesDropResearchPayload): Promise<BluesDropResearch> => {
    await safeAddTags(["blues-drop", "research"]);
    logger.info("starting blues-drop-research");

    const ghToken = await getSecret("JAEWILSON07_GH_PAT", { path: "/", recursive: false });
    // Neither SPOTIFY_CLIENT_ID nor SPOTIFY_CLIENT_SECRET lives under
    // /datacrew (verified 2026-08-19) — recursive from root is the only way
    // getSecret() finds them without knowing their exact folder.
    const spotifyClientId = await getSecret("SPOTIFY_CLIENT_ID", { path: "/", recursive: true });
    const spotifyClientSecret = await getSecret("SPOTIFY_CLIENT_SECRET", {
      path: "/",
      recursive: true,
    });

    const workspace = await setupIndbWorkspace(ghToken, "blues-drop-research-");
    try {
      logger.info("running uv sync", { cwd: workspace.indbDir });
      await runUv(workspace.indbDir, ["sync"]);

      logger.info("running blues_drop_artist_mode.py research");
      const result = await runUv(
        workspace.indbDir,
        ["run", "python", BLUES_DROP_SCRIPT_REL_PATH, "research"],
        {
          env: {
            ...process.env,
            SPOTIPY_CLIENT_ID: spotifyClientId,
            SPOTIPY_CLIENT_SECRET: spotifyClientSecret,
          },
          secrets: [spotifyClientId, spotifyClientSecret],
        }
      );

      // The script prints exactly one JSON line on success; `uv run` itself
      // may also emit a warning line to stdout (observed:
      // `VIRTUAL_ENV=... does not match the project environment path`), so
      // take the LAST non-empty line rather than assuming stdout is only
      // the JSON payload.
      const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        throw new Error(`blues_drop_artist_mode.py research produced no output. stderr: ${result.stderr}`);
      }
      const research = JSON.parse(lastLine) as BluesDropResearch;

      logger.info("blues-drop-research: complete", {
        weekId: research.weekId,
        topic: research.topic,
        tracks: research.tracks.length,
        alreadySynced: research.alreadySynced,
      });
      return research;
    } finally {
      await workspace.cleanup();
    }
  },
});
