import { task, logger, tags } from "@trigger.dev/sdk";
import { getSecret, runUv } from "@datacrew/trigger-shared";
import { setupIndbWorkspace, BLUES_DROP_SCRIPT_REL_PATH } from "../lib/indb-workspace.js";
import { searchBluesDropVideo } from "../lib/blues-drop-youtube.js";
import { searchBluesDropCoverage } from "../lib/blues-drop-coverage.js";
import type { BluesDropResearch, BluesDropVideo, BluesDropCoverage } from "../lib/blues-drop-types.js";

/**
 * The RESEARCH half of the Blues Drop of the Week
 * (`docs/ADR-002-research-seam-delivery-composition.md`): resolves this
 * week's artist-mode topic and Spotify-matches it, returning a
 * `BluesDropResearch` that knows no destination.
 *
 * Topic resolution + Spotify matching happens in `indb_discordbot`'s own
 * `blues_drop_artist_mode.py research` — invoked via the `git-uv`
 * clone-then-`uv run` pattern already live-verified for watchdog's
 * `crew-rag-domo-scrape` (`crewRagDomoScrape.ts`). That script resolves the
 * topic (round-robin over a curated "prolific artist" backlog, deterministic
 * on the ISO week number) and Spotify-matches it via the existing,
 * unmodified `curate-bma-nominees` runbook — this task does not
 * reimplement either.
 *
 * trigger-dev-workflows#101 adds two more topic-resolver modes (release,
 * Denver radar) and the default weekly rotation between artist-spotlight
 * and Denver radar — ALL resolved inside `blues_drop_artist_mode.py
 * research` itself (`--mode`/`--artist`/`--album`, forwarded from this
 * task's own `payload` below), not in this TypeScript body. Rotation logic
 * lives there rather than here specifically so a caller invoking the Python
 * script directly (a human debugging on their own machine, a future
 * non-trigger.dev caller) gets the exact same rotation/override behavior —
 * this task is a thin `git-uv` wrapper around it either way, same as #98's
 * original artist-only shape was.
 *
 * trigger-dev-workflows#100 adds two more independent research sources —
 * YouTube video + industry-coverage article — as plain concurrent calls
 * inside THIS task's own `run` body (`lib/blues-drop-youtube.ts` /
 * `lib/blues-drop-coverage.ts`), once the topic above is known. NOT new
 * child tasks composed with `triggerAndWait()`: ADR-002's "not `Promise.all`"
 * caution is specifically about composing multiple `triggerAndWait()` calls
 * to CHILD TASKS (unsupported), which doesn't apply here — these are two
 * plain async HTTP calls, not trigger.dev tasks, so ordinary
 * `Promise.allSettled` is the right tool: neither call can throw (both
 * helpers have a documented "never throws, `null` is a normal result"
 * contract), and `allSettled` additionally guarantees a slow/rejecting one
 * never delays or fails the other. #100's own requirement — a dead YouTube
 * key or an empty coverage search degrades the issue (missing section)
 * rather than blocking delivery — falls out of that contract for free; it
 * does not also need to avoid blocking the Python subprocess above, since
 * that has already completed by the time these two run.
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

/**
 * trigger-dev-workflows#101 — an operator-forced mode override, forwarded
 * as-is to `blues_drop_artist_mode.py research`'s own `--mode`/`--artist`/
 * `--album` flags. Every field is optional: `triggerAndWait({})` (every
 * other research task's call shape, and `bluesDropFullRun`'s own PRODUCTION
 * cron path) still resolves the default weekly rotation — Denver radar wins
 * when a real show exists for the coming week, artist-spotlight otherwise.
 */
export type BluesDropResearchPayload = {
  /** Forces one specific topic-resolver mode, overriding the default weekly
   * rotation. Omit for the default rotation. */
  mode?: "artist" | "release" | "denver";
  /** Required together with `mode: "release"` — release mode has no topic
   * discovery pipeline of its own (see `blues_drop_artist_mode.py`'s module
   * docstring), so the operator supplies the pair directly. Ignored for
   * every other mode. */
  artist?: string;
  album?: string;
};

/** What `blues_drop_artist_mode.py research` itself prints — everything
 * `BluesDropResearch` carries EXCEPT the two fields #100 resolves in this
 * task's own TypeScript body, not in that subprocess. */
type PythonResearchResult = Omit<BluesDropResearch, "video" | "coverage">;

/**
 * `getSecret()` throws on a missing key — correct for a secret a task
 * genuinely cannot run without (Spotify, the GitHub PAT), wrong for one
 * whose absence is a normal, documented "this source isn't configured yet"
 * state (#100's YouTube key; mdrag's token, in case a checkout genuinely has
 * neither `DATACREW_API_TOKEN` set up). Only swallows THAT specific
 * not-found shape (`infisical.ts`'s own `getSecret` error text) — any other
 * failure (bad Infisical auth, a network error) is a real problem and must
 * still bubble up rather than silently degrade into "no video today."
 */
async function getOptionalSecret(key: string): Promise<string | null> {
  try {
    return await getSecret(key, { path: "/", recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`Secret ${key} not found`)) {
      return null;
    }
    throw error;
  }
}

export const bluesDropResearch = task({
  id: "blues-drop-research",
  // The child `uv run` does the retry-worthy work (Spotify API calls); a
  // couple of attempts here covers a transient clone/sync failure without
  // masking a genuine bug behind endless retries.
  retry: { maxAttempts: 2 },
  maxDuration: 600,
  run: async (payload: BluesDropResearchPayload): Promise<BluesDropResearch> => {
    await safeAddTags(["blues-drop", "research"]);
    logger.info("starting blues-drop-research", { mode: payload.mode ?? "default-rotation" });

    // Fail fast, before spending a clone + `uv sync` on a request that
    // `blues_drop_artist_mode.py` would reject anyway (it raises the same
    // check) — same "requires both" wording so a caller sees one consistent
    // error message regardless of which layer catches it first.
    if (payload.mode === "release" && (!payload.artist || !payload.album)) {
      throw new Error('blues-drop-research: mode "release" requires both "artist" and "album" in the payload');
    }

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

      // trigger-dev-workflows#101: forwarded as-is to the Python script's
      // own `--mode`/`--artist`/`--album` flags — the mode-resolution logic
      // (default rotation vs. forced override) lives entirely in
      // `blues_drop_artist_mode.py research`, not here (see this file's own
      // module docstring for why).
      const modeArgs: string[] = [];
      if (payload.mode) {
        modeArgs.push("--mode", payload.mode);
      }
      if (payload.artist) {
        modeArgs.push("--artist", payload.artist);
      }
      if (payload.album) {
        modeArgs.push("--album", payload.album);
      }

      logger.info("running blues_drop_artist_mode.py research", { modeArgs });
      const result = await runUv(
        workspace.indbDir,
        ["run", "python", BLUES_DROP_SCRIPT_REL_PATH, "research", ...modeArgs],
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
      const pythonResult = JSON.parse(lastLine) as PythonResearchResult;

      logger.info("blues-drop-research: topic resolved, starting video + coverage research", {
        weekId: pythonResult.weekId,
        topic: pythonResult.topic,
      });

      // #100: two independent sources, run concurrently now that `topic` is
      // known. `Promise.allSettled` (not `Promise.all`) so one rejecting
      // never costs the other — though neither helper is documented to
      // reject at all; this is defense in depth, not the primary mechanism
      // (see this task's own module docstring).
      const [youtubeKey, mdragToken] = await Promise.all([
        getOptionalSecret("YOUTUBE_API_KEY"),
        getOptionalSecret("DATACREW_API_TOKEN"),
      ]);

      const videoQuery = `${pythonResult.topic} official live performance blues`;
      const coverageQuery = `${pythonResult.topic} blues`;

      const [videoOutcome, coverageOutcome] = await Promise.allSettled([
        searchBluesDropVideo(videoQuery, youtubeKey),
        searchBluesDropCoverage(coverageQuery, mdragToken),
      ]);

      const video: BluesDropVideo | null =
        videoOutcome.status === "fulfilled" ? videoOutcome.value : null;
      if (videoOutcome.status === "rejected") {
        logger.warn("research-youtube: unexpectedly rejected (should never throw), treating as no video", {
          error: String(videoOutcome.reason),
        });
      }

      const coverage: BluesDropCoverage | null =
        coverageOutcome.status === "fulfilled" ? coverageOutcome.value : null;
      if (coverageOutcome.status === "rejected") {
        logger.warn(
          "research-coverage: unexpectedly rejected (should never throw), treating as no coverage",
          { error: String(coverageOutcome.reason) }
        );
      }

      const research: BluesDropResearch = { ...pythonResult, video, coverage };

      logger.info("blues-drop-research: complete", {
        weekId: research.weekId,
        topic: research.topic,
        tracks: research.tracks.length,
        alreadySynced: research.alreadySynced,
        hasVideo: research.video !== null,
        hasCoverage: research.coverage !== null,
      });
      return research;
    } finally {
      await workspace.cleanup();
    }
  },
});
