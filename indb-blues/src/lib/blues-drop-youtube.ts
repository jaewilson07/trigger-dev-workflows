import { logger } from "@trigger.dev/sdk";
import type { BluesDropVideo } from "./blues-drop-types.js";

/**
 * YouTube video research for the Blues Drop of the Week
 * (trigger-dev-workflows#100): an official video / live performance /
 * interview link for the week's topic.
 *
 * ## Credential status (checked live 2026-08-19 — read this before adding a
 * caller that assumes a key already works)
 *
 * `GOOGLE_TOKEN_API_KEY` (Infisical, homeserver project 3fbb4296…, root
 * path) is NOT a Google Cloud API key, despite the name. Confirmed live: a
 * direct call to `https://www.googleapis.com/youtube/v3/search` with that
 * value 400s with `API_KEY_INVALID`. Reading
 * `watchdog/src/lib/google-auth.ts` / `executive-assistant/lib/google-auth.ts`
 * explains why — it's sent as an `X-Token-API-Key` header to this org's OWN
 * auth-service (`api.datacrew.space/auth/google/token/<email>`) to fetch a
 * STORED Gmail OAuth token; a different-purpose credential entirely (same
 * kind of name collision `executive-assistant/tasks/report-mdrag.ts`'s own
 * comment documents for `MDRAG_TOKEN`). This module does not call that
 * secret at all — passing it in here would just reproduce the 400.
 *
 * mdrag's own `youtube` Provider (`POST /api/v1/primitives/search-providers`,
 * `provider: "youtube"` — see `mdrag.providers.entrypoint.PROVIDER_REGISTRY`)
 * was also tried live for this issue via the token credential path and
 * currently returns 502 — a pre-existing mdrag-side gap (that endpoint's own
 * server-side YouTube credential appears unconfigured or broken), unrelated
 * to this repo and not something a client-side workaround here can fix. Not
 * used as the source for that reason — `lib/blues-drop-coverage.ts` uses
 * mdrag's `web` Provider instead, which works.
 *
 * So: no working YouTube credential exists in this org today. This module
 * still implements the real request against a `YOUTUBE_API_KEY` secret name
 * (not yet in Infisical) so wiring up a real key later is a one-line
 * Infisical write, not a code change. Minting one is a manual follow-up:
 * Google Cloud Console → enable "YouTube Data API v3" → Credentials → create
 * an API key → store it in Infisical (homeserver project, root path) as
 * `YOUTUBE_API_KEY`.
 *
 * ## Failure contract
 *
 * Never throws. No configured key, a non-2xx response, a malformed body, or
 * zero results are all the same outcome to the caller: `null` — an explicit
 * "no video" research result, matching this repo's `skipped`-is-a-result
 * vocabulary applied to a research source rather than a delivery
 * destination (see `blues-drop-types.ts`'s `BluesDropVideo` doc comment).
 * `bluesDropResearch`'s topic resolution + Spotify match must complete
 * regardless of what happens here.
 */

const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const REQUEST_TIMEOUT_MS = 15_000;

type YouTubeSearchResponse = {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: { title?: string; channelTitle?: string };
  }>;
};

/**
 * @param query What to search for — callers pass a query already shaped for
 * "official video / live performance / interview" (see `bluesDropResearch.ts`).
 * @param apiKey The YouTube Data API v3 key, or `null`/empty/undefined when
 * none is configured — treated as "skip", not an error.
 */
export async function searchBluesDropVideo(
  query: string,
  apiKey: string | null | undefined
): Promise<BluesDropVideo | null> {
  if (!apiKey) {
    logger.info("research-youtube: skipped — no working YouTube credential configured", { query });
    return null;
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: "1",
    safeSearch: "moderate",
    key: apiKey,
  });

  try {
    const res = await fetch(`${YOUTUBE_SEARCH_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      // The key itself is never logged — only the response status/body,
      // which YouTube's own error payload never echoes back.
      const body = await res.text().catch(() => "");
      logger.warn("research-youtube: YouTube API returned a non-2xx status, treating as no video", {
        status: res.status,
        body: body.slice(0, 500),
      });
      return null;
    }

    const data = (await res.json()) as YouTubeSearchResponse;
    const hit = data.items?.[0];
    const videoId = hit?.id?.videoId;
    if (!videoId || !hit?.snippet?.title) {
      logger.info("research-youtube: no video found", { query });
      return null;
    }

    return {
      title: hit.snippet.title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      channelTitle: hit.snippet.channelTitle ?? "",
    };
  } catch (error) {
    logger.warn("research-youtube: request failed, treating as no video", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
