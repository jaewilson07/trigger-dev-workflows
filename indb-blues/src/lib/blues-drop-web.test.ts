import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBluesDropPage, bluesDropWebUrl } from "./blues-drop-web.js";
import type { BluesDropResearch } from "./blues-drop-types.js";

function baseResearch(overrides: Partial<BluesDropResearch> = {}): BluesDropResearch {
  return {
    weekId: "2026-W34",
    mode: "artist-spotlight",
    topic: "Buddy Guy",
    sourceUrl: "https://en.wikipedia.org/wiki/Buddy_Guy",
    contextParagraph: "A Chicago blues guitarist.",
    alreadySynced: false,
    tracks: [],
    generatedAt: "2026-08-19T16:17:40.856022+00:00",
    video: null,
    coverage: null,
    ...overrides,
  };
}

describe("bluesDropWebUrl", () => {
  it("is deterministic from weekId alone, matching deliver-web's publish path", () => {
    assert.equal(
      bluesDropWebUrl("2026-W34"),
      "https://jaewilson07.github.io/indb_discordbot/drops/2026-W34/"
    );
  });
});

describe("renderBluesDropPage", () => {
  it("includes the topic, week, and source link", () => {
    const html = renderBluesDropPage(baseResearch());
    assert.match(html, /<title>Buddy Guy — Blues Music Drops<\/title>/);
    assert.match(html, /<h1>Buddy Guy<\/h1>/);
    assert.match(html, /Week 2026-W34/);
    assert.match(html, /href="https:\/\/en\.wikipedia\.org\/wiki\/Buddy_Guy"/);
  });

  it("omits the tracks/video/coverage sections entirely when absent — never an empty heading", () => {
    const html = renderBluesDropPage(baseResearch());
    assert.doesNotMatch(html, /This week's tracks/);
    assert.doesNotMatch(html, /<h2>Watch<\/h2>/);
    assert.doesNotMatch(html, /<h2>Reading<\/h2>/);
  });

  it("renders a track card per track, with a Spotify link", () => {
    const html = renderBluesDropPage(
      baseResearch({
        tracks: [
          {
            artist: "Buddy Guy",
            album: "Damn Right, I've Got the Blues",
            categories: ["chicago blues"],
            spotify_url: "https://open.spotify.com/album/real-id",
            spotify_id: "real-id",
            matched: true,
          },
        ],
      })
    );
    assert.match(html, /This week's tracks/);
    assert.match(html, /Damn Right, I&#39;ve Got the Blues/);
    assert.match(html, /href="https:\/\/open\.spotify\.com\/album\/real-id"/);
    assert.match(html, />Play on Spotify →</);
  });

  it("falls back to a Spotify search link when a track has no matched URL", () => {
    const html = renderBluesDropPage(
      baseResearch({
        tracks: [
          {
            artist: "Buddy Guy",
            album: "Skin Deep",
            categories: [],
            spotify_url: null,
            spotify_id: null,
            matched: false,
          },
        ],
      })
    );
    assert.match(html, /open\.spotify\.com\/search\/Buddy%20Guy%20Skin%20Deep/);
    assert.match(html, />Search on Spotify →</);
  });

  it("renders the video and coverage sections when present", () => {
    const html = renderBluesDropPage(
      baseResearch({
        video: {
          title: "Buddy Guy Live at Legends",
          url: "https://youtube.com/watch?v=example",
          channelTitle: "Buddy Guy's Legends",
        },
        coverage: {
          title: "Buddy Guy at 89",
          url: "https://example.com/article",
          summary: "A profile of his continued touring.",
        },
      })
    );
    assert.match(html, /<h2>Watch<\/h2>/);
    assert.match(html, /Buddy Guy Live at Legends/);
    assert.match(html, /<h2>Reading<\/h2>/);
    assert.match(html, /A profile of his continued touring\./);
  });

  it("includes the Discord link-back only when discordUrl is passed", () => {
    const withLink = renderBluesDropPage(baseResearch(), {
      discordUrl: "https://discord.com/channels/1/2/3",
    });
    const withoutLink = renderBluesDropPage(baseResearch());
    assert.match(withLink, /Discuss on Discord/);
    assert.doesNotMatch(withoutLink, /Discuss on Discord/);
  });

  it("shows the sample badge only when isSample is set", () => {
    const sample = renderBluesDropPage(baseResearch(), { isSample: true });
    const real = renderBluesDropPage(baseResearch());
    assert.match(sample, /Template sample/);
    assert.doesNotMatch(real, /Template sample/);
  });

  it("HTML-escapes topic/context/track fields — no raw injection from research content", () => {
    const html = renderBluesDropPage(
      baseResearch({ topic: "<script>alert(1)</script>", contextParagraph: "A & B" })
    );
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /A &amp; B/);
  });
});
