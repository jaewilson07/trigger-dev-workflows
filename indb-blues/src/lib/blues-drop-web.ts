import type { BluesDropResearch } from "./blues-drop-types.js";

/**
 * Renders a `BluesDropResearch` payload into a complete, self-contained
 * static HTML page — the third delivery destination alongside Discord and
 * Notion (trigger-dev-workflows#111). Published by `tasks/deliver-web.ts`
 * to the `gh-pages` orphan branch of `indb_discordbot`, so this function has
 * no side effects and no dependency on trigger.dev — it's a pure string
 * transform, testable with a plain fixture and no mocking.
 *
 * The design system is carried over deliberately from the original Blues
 * Music Drops proposal doc (the one that got this whole feature greenlit) —
 * Fraunces/Karla/IBM Plex Mono, warm cream palette, card/tag components —
 * because Notion's block editor can't carry any of it. This page is what
 * "the actual music drop" looks like with real typography; Notion and
 * Discord stay the structured/chat-native destinations.
 *
 * NOT a component of `BluesDropResearch` itself: `mode` label text,
 * Spotify-search fallback links, and section presence are all derived here
 * from the existing seam type — no schema changes upstream. A section
 * (tracks/video/coverage) is omitted entirely rather than rendered empty,
 * matching the "skipped is a result" contract those fields already carry
 * (`video`/`coverage` are `null`, not an empty placeholder object, when
 * nothing was found).
 */

/** `gh-pages` is served at this fixed GitHub Pages URL for as long as the
 * repo stays `jaewilson07/indb_discordbot` — not derived from any API call,
 * since GitHub Pages URLs for a user-owned repo follow this exact,
 * documented pattern deterministically. */
const GH_PAGES_BASE = "https://jaewilson07.github.io/indb_discordbot";

/**
 * The one place both `deliver-web` (which publishes here) and
 * `bluesDropDeliver` (which needs this URL for Discord's link-back, without
 * waiting on deliver-web's own result — see that file's doc comment) compute
 * this week's page URL, so the two can never drift apart.
 */
export function bluesDropWebUrl(weekId: string): string {
  return `${GH_PAGES_BASE}/drops/${weekId}/`;
}

const MODE_LABEL: Record<BluesDropResearch["mode"], string> = {
  "artist-spotlight": "Artist Spotlight",
  release: "Release Spotlight",
  denver: "Denver Radar",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function spotifySearchUrl(query: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}

function renderTrackCard(track: BluesDropResearch["tracks"][number]): string {
  const link = track.matched && track.spotify_url
    ? track.spotify_url
    : spotifySearchUrl(`${track.artist} ${track.album}`);
  const linkLabel = track.matched && track.spotify_url ? "Play on Spotify" : "Search on Spotify";
  const tags = track.categories
    .map((c) => `<span class="tag tag-cat">${escapeHtml(c)}</span>`)
    .join("");
  return `
      <div class="track-card">
        <span class="track-artist">${escapeHtml(track.artist)}</span>
        <span class="track-album">${escapeHtml(track.album)}</span>
        ${tags ? `<div class="track-tags">${tags}</div>` : ""}
        <a class="track-link" href="${escapeHtml(link)}">${linkLabel} →</a>
      </div>`;
}

function renderVideoSection(video: BluesDropResearch["video"]): string {
  if (!video) return "";
  return `
  <section>
    <h2>Watch</h2>
    <div class="media-card">
      <span class="media-kicker">${escapeHtml(video.channelTitle)}</span>
      <h3><a href="${escapeHtml(video.url)}">${escapeHtml(video.title)}</a></h3>
    </div>
  </section>`;
}

function renderCoverageSection(coverage: BluesDropResearch["coverage"]): string {
  if (!coverage) return "";
  return `
  <section>
    <h2>Reading</h2>
    <div class="media-card">
      <h3><a href="${escapeHtml(coverage.url)}">${escapeHtml(coverage.title)}</a></h3>
      <p>${escapeHtml(coverage.summary)}</p>
    </div>
  </section>`;
}

function renderTracksSection(tracks: BluesDropResearch["tracks"]): string {
  if (!tracks.length) return "";
  return `
  <section>
    <h2>This week's tracks</h2>
    <div class="tracks">${tracks.map(renderTrackCard).join("")}
    </div>
  </section>`;
}

export type RenderBluesDropPageOptions = {
  /** Discord thread URL for this week, if delivery already happened —
   * omitted from the page (not just blank) when not yet known, since the
   * three destinations deliver in parallel and web has no guarantee
   * Discord's post exists yet by the time it renders. */
  discordUrl?: string;
  /** Marks the page as a template/design sample rather than a real weekly
   * drop — used for the one-off page that proves the template out, never
   * set by `deliver-web`'s real weekly runs. */
  isSample?: boolean;
};

export function renderBluesDropPage(
  research: BluesDropResearch,
  options: RenderBluesDropPageOptions = {}
): string {
  const modeLabel = MODE_LABEL[research.mode] ?? research.mode;
  const generated = new Date(research.generatedAt);
  const generatedLabel = Number.isNaN(generated.getTime())
    ? research.generatedAt
    : generated.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(research.topic)} — Blues Music Drops</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Karla:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

  :root {
    --bg: #f1ede3;
    --surface: #ffffff;
    --surface-2: #e8e1d0;
    --text: #211d17;
    --text-dim: #6b6355;
    --accent: #a5701c;
    --accent-strong: #7d5314;
    --accent-2: #2e5f66;
    --border: rgba(33, 29, 23, 0.14);
    --tag-bg: #f1e6cf;
    --tag-text: #6b4a10;
    --shadow: 0 1px 2px rgba(33, 29, 23, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16141a;
      --surface: #1e1c24;
      --surface-2: #262330;
      --text: #ece7dc;
      --text-dim: #a29c8e;
      --accent: #d9a441;
      --accent-strong: #eec06a;
      --accent-2: #6fb3bd;
      --border: rgba(236, 231, 220, 0.13);
      --tag-bg: #362a15;
      --tag-text: #eec06a;
      --shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    }
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text);
    font-family: 'Karla', system-ui, -apple-system, sans-serif;
    font-size: 16.5px; line-height: 1.65; margin: 0;
    padding: 5rem 1.5rem 7rem;
  }
  .page { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 3rem; }
  .masthead { display: flex; flex-direction: column; gap: 0.9rem; }
  .eyebrow {
    font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent-strong);
    display: flex; align-items: center; gap: 0.6rem;
  }
  .eyebrow::before { content: ""; width: 1.4rem; height: 1px; background: var(--accent-strong); }
  .sample-badge {
    font-family: 'IBM Plex Mono', monospace; font-size: 0.66rem;
    letter-spacing: 0.06em; text-transform: uppercase; padding: 0.15em 0.55em;
    border-radius: 5px; background: var(--tag-bg); color: var(--tag-text);
  }
  h1 {
    font-family: 'Fraunces', Georgia, serif; font-optical-sizing: auto; font-weight: 600;
    font-size: clamp(2.1rem, 5vw, 2.85rem); line-height: 1.08; margin: 0;
    text-wrap: balance; letter-spacing: -0.01em;
  }
  .dek { font-size: 1.08rem; color: var(--text-dim); max-width: 60ch; text-wrap: pretty; margin: 0; }
  .meta-row {
    display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem;
    font-family: 'IBM Plex Mono', monospace; font-size: 0.78rem; color: var(--text-dim);
    padding-top: 0.5rem; border-top: 1px solid var(--border);
  }
  .meta-row a { color: var(--accent-2); }
  section { display: flex; flex-direction: column; gap: 1.1rem; }
  h2 {
    font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-size: 1.5rem;
    margin: 0; letter-spacing: -0.005em;
  }
  h3 { font-family: 'Karla', sans-serif; font-weight: 700; font-size: 1.05rem; margin: 0; }
  h3 a { color: var(--text); text-decoration: none; }
  h3 a:hover { color: var(--accent-2); }
  p { margin: 0; text-wrap: pretty; }
  a { color: var(--accent-2); text-decoration-color: rgba(46,95,102,0.4); text-underline-offset: 2px; }
  a:hover { text-decoration-color: currentColor; }

  .tracks { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.9rem; }
  @media (max-width: 560px) { .tracks { grid-template-columns: 1fr; } }
  .track-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 1.1rem; box-shadow: var(--shadow);
    display: flex; flex-direction: column; gap: 0.35rem;
  }
  .track-artist { font-family: 'Fraunces', serif; font-weight: 600; font-size: 1.05rem; }
  .track-album { font-size: 0.88rem; color: var(--text-dim); }
  .track-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.2rem; }
  .tag { font-family: 'IBM Plex Mono', monospace; font-size: 0.64rem; letter-spacing: 0.05em;
    text-transform: uppercase; padding: 0.15em 0.5em; border-radius: 5px; }
  .tag-cat { background: var(--tag-bg); color: var(--tag-text); }
  .track-link { font-size: 0.85rem; margin-top: 0.5rem; }

  .media-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 1.1rem; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 0.4rem;
  }
  .media-kicker {
    font-family: 'IBM Plex Mono', monospace; font-size: 0.66rem; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--accent-strong);
  }
  .media-card p { font-size: 0.92rem; color: var(--text-dim); }

  footer {
    font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; color: var(--text-dim);
    display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;
    border-top: 1px solid var(--border); padding-top: 1.25rem;
  }
</style>
</head>
<body>
<div class="page">

  <div class="masthead">
    <div class="eyebrow">Blues Music Drops · ${escapeHtml(modeLabel)} · Week ${escapeHtml(research.weekId)}</div>
    <h1>${escapeHtml(research.topic)}</h1>
    <p class="dek">${escapeHtml(research.contextParagraph)}</p>
    <div class="meta-row">
      ${options.isSample ? '<span class="sample-badge">Template sample</span>' : ""}
      <span>Source: <a href="${escapeHtml(research.sourceUrl)}">${escapeHtml(new URL(research.sourceUrl).hostname)}</a></span>
      <span>Published ${escapeHtml(generatedLabel)}</span>
      ${options.discordUrl ? `<span><a href="${escapeHtml(options.discordUrl)}">Discuss on Discord →</a></span>` : ""}
    </div>
  </div>
${renderTracksSection(research.tracks)}
${renderVideoSection(research.video)}
${renderCoverageSection(research.coverage)}
  <footer>
    <span>Blues Music Drops — indb_discordbot</span>
    <span>Week ${escapeHtml(research.weekId)}</span>
  </footer>

</div>
</body>
</html>
`;
}
