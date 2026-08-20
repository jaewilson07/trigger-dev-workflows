// One-off script: renders a sample Blues Music Drops page and writes it to
// stdout. Not part of the deployed task set — used to produce the design
// sample published to indb_discordbot's gh-pages branch, and as a manual
// spot-check of `renderBluesDropPage()` during development.
//
// Sample content uses the real week-2026-W34 topic and source (from
// indb_discordbot's own drop_manifest.json — that week's Discord post
// genuinely went out), but the video/coverage fields are left `null` rather
// than invented, since the actual research payload from that live run
// wasn't captured. That also doubles as a real test of the template's
// graceful-omission behavior for missing optional sections.
import { renderBluesDropPage } from "../src/lib/blues-drop-web.js";
import type { BluesDropResearch } from "../src/lib/blues-drop-types.js";

const sample: BluesDropResearch = {
  weekId: "2026-W34",
  mode: "artist-spotlight",
  topic: "Buddy Guy",
  sourceUrl: "https://en.wikipedia.org/wiki/Buddy_Guy",
  contextParagraph:
    "Buddy Guy is a Chicago blues guitarist and singer whose raw, feedback-drenched style " +
    "shaped a generation of players — Hendrix, Clapton, and Stevie Ray Vaughan all named him " +
    "as a direct influence. A Grammy winner and Kennedy Center Honoree, he's still touring and " +
    "recording into his late eighties, and still owns the Chicago club that carries his name.",
  alreadySynced: true,
  tracks: [
    {
      artist: "Buddy Guy",
      album: "Damn Right, I've Got the Blues",
      categories: ["chicago blues", "electric blues"],
      spotify_url: null,
      spotify_id: null,
      matched: false,
    },
    {
      artist: "Buddy Guy",
      album: "Skin Deep",
      categories: ["chicago blues"],
      spotify_url: null,
      spotify_id: null,
      matched: false,
    },
  ],
  generatedAt: "2026-08-19T16:17:40.856022+00:00",
  video: null,
  coverage: null,
};

process.stdout.write(renderBluesDropPage(sample, { isSample: true }));
