import test from "node:test";
import assert from "node:assert/strict";
import { captureLivekitDocs, collectPageUrls, markdownUrl, parseIndexLinks, sha256 } from "./livekitDocsCaptureCore.js";
import type { Fetcher } from "./livekitDocsCaptureCore.js";

const site: Record<string, string> = {
  "https://docs.livekit.io/llms.txt": "- [Agents](https://docs.livekit.io/agents/llms.txt)\n- [Ext](https://example.com/x)",
  "https://docs.livekit.io/agents/llms.txt":
    "- [Intro](https://docs.livekit.io/agents/)\n- [Tools](/agents/tools#frag)\n- [Dup](https://docs.livekit.io/agents/tools/)",
  "https://docs.livekit.io/agents.md": "# Intro\nbody",
  "https://docs.livekit.io/agents/tools.md": "# Tools\nv1",
};
const fetcher: Fetcher = async (url) => {
  const body = site[url];
  return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" };
};

test("parseIndexLinks keeps only docs.livekit.io, drops fragments, dedupes", () => {
  assert.deepEqual(parseIndexLinks(site["https://docs.livekit.io/agents/llms.txt"]!), [
    "https://docs.livekit.io/agents/",
    "https://docs.livekit.io/agents/tools",
    "https://docs.livekit.io/agents/tools/",
  ]);
});

test("markdownUrl appends .md once", () => {
  assert.equal(markdownUrl("https://docs.livekit.io/agents/"), "https://docs.livekit.io/agents.md");
  assert.equal(markdownUrl("https://docs.livekit.io/a.md"), "https://docs.livekit.io/a.md");
});

test("collectPageUrls follows section indexes", async () => {
  assert.deepEqual(await collectPageUrls(fetcher), [
    "https://docs.livekit.io/agents.md",
    "https://docs.livekit.io/agents/tools.md",
  ]);
});

test("unchanged pages are skipped, changed ones re-ingested, failures keep the old hash", async () => {
  const ingested: string[] = [];
  const previous = { "https://docs.livekit.io/agents.md": sha256("# Intro\nbody"), "https://docs.livekit.io/agents/tools.md": "stale" };
  const r = await captureLivekitDocs(previous, { fetcher, ingest: async (p) => void ingested.push(p.url) });
  assert.deepEqual(ingested, ["https://docs.livekit.io/agents/tools.md"]);
  assert.equal(r.unchanged, 1);

  const failing = await captureLivekitDocs(previous, {
    fetcher,
    ingest: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(failing.failed.length, 1);
  assert.equal(failing.hashes["https://docs.livekit.io/agents/tools.md"], "stale");
});
