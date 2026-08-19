import type { BluesDropResearch } from "./blues-drop-types.js";

/**
 * Renders a `BluesDropResearch` to markdown for the Notion destination
 * (trigger-dev-workflows#99).
 *
 * Deliberately close to, but not required to byte-match,
 * `indb_discordbot`'s own `blues_drop_artist_mode.py`'s `format_markdown()`
 * (the reference this issue names) — that function is Python, runs inside
 * `deliver-discord`'s subprocess, and is tuned for a 1900-char Discord
 * message cap the Notion destination doesn't share. This is an independent
 * TypeScript port of the same shape (context paragraph, then one entry per
 * track with its Spotify link), run once in `blues-drop-deliver` and handed
 * to `markdownToBlocks` (`@datacrew/trigger-shared`'s `notion.ts`) rather
 * than re-run per destination.
 *
 * The header date is the RESEARCHED date (`research.generatedAt`), not
 * `today` — same reasoning `docs/notion-delivery.md` documents for every
 * other Notion destination in this repo: a re-delivery of an older week
 * files itself under, and renders, that week's own date, not the date of
 * the retry.
 */

function formatLongDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** `YYYY-MM-DD`, for the Notion title (upsert key) and the `Date` property. */
export function blueDropIsoDate(research: BluesDropResearch): string {
  return research.generatedAt.slice(0, 10);
}

/**
 * `"Blues Music Drops — <date> — <topic>"`, matching this issue's title
 * format and the ISO-date convention `docs/notion-delivery.md`'s worked
 * examples use (`Morning Brief — 2026-08-05`, `Infra health — 2026-08-05`)
 * — not the `"%B %d, %Y"` style `blues_drop_artist_mode.py` uses for the
 * Discord post title, which is a different destination with its own
 * conventions. The title is the upsert key: re-delivering the same week
 * resolves to, and rewrites, the same Notion row.
 */
export function renderBluesDropTitle(research: BluesDropResearch): string {
  return `Blues Music Drops — ${blueDropIsoDate(research)} — ${research.topic}`;
}

export function renderBluesDropMarkdown(research: BluesDropResearch): string {
  const dateStr = formatLongDate(research.generatedAt);
  const lines: string[] = [
    `**[${dateStr}] - Drop of the Week | ${research.topic}**`,
    "",
    "## About This Drop",
    "",
    research.contextParagraph,
    "",
    "## The Music",
    "",
  ];

  research.tracks.forEach((track, i) => {
    lines.push(`**${i + 1}. ${track.artist || "Unknown"} — ${track.album || "Unknown"}**`);
    if (track.spotify_url) {
      lines.push(track.spotify_url);
    } else {
      lines.push("*(Spotify link not found)*");
    }
    lines.push("");
  });

  lines.push(
    "---",
    "",
    `📚 **Source:** [${research.topic}](${research.sourceUrl})`,
    "📅 Curated by INDB Bot"
  );

  return lines.join("\n");
}
