import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  GitHubAccessError,
  assessRepo,
  buildRevisionIssue,
  createHfClient,
  diffFiles,
  filesMarker,
  newFamilyRepos,
  parseFilesMarker,
  runModelDriftSweep,
  type HfClient,
  type HfModelInfo,
  type IssueClient,
  type ModelWatchManifest,
} from "./model-drift.js";

const SINCE = "2026-09-29T00:00:00Z";

function manifest(overrides: Partial<ModelWatchManifest> = {}): ModelWatchManifest {
  return {
    issueRepo: "o/infra",
    fallbackIssueRepo: "o/fallback",
    issueLabels: ["model-drift"],
    watchSince: SINCE,
    maxNewFamilyIssuesPerRun: 2,
    filePattern: "\\.gguf$",
    models: [
      {
        id: "chat",
        name: "Chat",
        deployedIn: "apps/x",
        pinnedFiles: ["a.gguf"],
        repos: [{ repo: "acme/Chat-GGUF", role: "base", pinnedRevision: "aaa1111" }],
        families: [{ author: "acme", search: "Chat", pattern: "Chat-(4|5)", flags: "i" }],
      },
    ],
    ...overrides,
  };
}

function info(sha: string, files: string[] = ["a.gguf"], lastModified = "2026-10-01T00:00:00Z"): HfModelInfo {
  return { id: "acme/Chat-GGUF", sha, lastModified, files };
}

function fakeHf(models: Record<string, HfModelInfo | Error>, hits: Array<{ id: string; createdAt: string }> = []): HfClient {
  return {
    async model(repo) {
      const m = models[repo];
      if (!m) throw new Error(`no fixture for ${repo}`);
      if (m instanceof Error) throw m;
      return m;
    },
    async search() {
      return hits;
    },
  };
}

type Filed = { title: string; body: string };
function fakeIssues(repo = "o/infra", opts: { denied?: boolean } = {}) {
  const store: Filed[] = [];
  const client: IssueClient = {
    repo,
    async probe() {
      if (opts.denied) throw new GitHubAccessError("GitHub API /repos -> 404", 404);
    },
    async findByMarker(marker) {
      const i = store.findIndex((s) => s.body.includes(`<!-- ${marker} -->`));
      return i >= 0 ? { number: i + 1, html_url: `u/${i + 1}`, body: store[i].body } : null;
    },
    async findLatestByMarkerPrefix(prefix) {
      for (let i = store.length - 1; i >= 0; i--) {
        if (store[i].body.includes(`<!-- ${prefix}`)) return { number: i + 1, html_url: `u/${i + 1}`, body: store[i].body };
      }
      return null;
    },
    async createIssue(title, body) {
      store.push({ title, body });
      return { number: store.length, html_url: `u/${store.length}` };
    },
  };
  return { client, store };
}

test("pinned repo: unchanged sha is quiet, changed sha flags", () => {
  const w = { repo: "r", role: "x", pinnedRevision: "aaa1111" };
  assert.equal(assessRepo(w, info("aaa1111"), SINCE).changed, false);
  assert.equal(assessRepo(w, info("bbb2222"), SINCE).changed, true);
});

test("unpinned repo flags only when modified after the baseline", () => {
  const w = { repo: "r", role: "x" };
  assert.equal(assessRepo(w, info("s", [], "2026-09-21T00:00:00Z"), SINCE).changed, false);
  assert.equal(assessRepo(w, info("s", [], "2026-10-02T00:00:00Z"), SINCE).changed, true);
});

test("family search keeps new, matching, unwatched repos only", () => {
  const fam = { author: "acme", search: "Chat", pattern: "Chat-(4|5)", flags: "i" };
  const hits = [
    { id: "acme/Chat-5-GGUF", createdAt: "2026-10-01T00:00:00Z" },
    { id: "acme/Chat-5-old", createdAt: "2026-01-01T00:00:00Z" },
    { id: "acme/Chat-3", createdAt: "2026-10-01T00:00:00Z" },
    { id: "acme/Chat-4", createdAt: "2026-10-01T00:00:00Z" },
  ];
  const got = newFamilyRepos(fam, hits, new Set(["acme/chat-4"]), SINCE);
  assert.deepEqual(got.map((h) => h.id), ["acme/Chat-5-GGUF"]);
});

test("file marker round-trips, and diff needs a prior snapshot", () => {
  const files = ["a.gguf", "we--ird.gguf"];
  assert.deepEqual(parseFilesMarker(filesMarker(files)), files);
  assert.equal(diffFiles(null, files), null);
  assert.deepEqual(diffFiles(["a.gguf"], files), ["we--ird.gguf"]);
  assert.equal(filesMarker(files).replace("<!-- model-drift-files:", "").replace(" -->", "").includes("--"), false);
});

test("issue body carries model, pin, what is new, link and the GPU_BESTEFFORT probe note", () => {
  const m = manifest();
  const issue = buildRevisionIssue({
    model: m.models[0],
    watched: m.models[0].repos[0],
    info: info("bbb2222bbb", ["a.gguf", "b-Q4.gguf"]),
    assessment: { changed: true, reason: "sha differs" },
    newFiles: ["b-Q4.gguf"],
    interesting: ["a.gguf", "b-Q4.gguf"],
  });
  for (const needle of ["Chat", "aaa1111", "b-Q4.gguf", "https://huggingface.co/acme/Chat-GGUF", "GPU_BESTEFFORT", "<!-- model-drift:acme/Chat-GGUF@bbb2222bbb -->"]) {
    assert.ok(issue.body.includes(needle), needle);
  }
});

test("sweep files once, then dedupes the same revision on the next run", async () => {
  const hf = fakeHf({ "acme/Chat-GGUF": info("bbb2222bbb", ["a.gguf", "new.gguf"]) });
  const { client, store } = fakeIssues();
  const first = await runModelDriftSweep({ manifest: manifest(), hf, primary: client });
  assert.deepEqual(first.findings.map((f) => f.action), ["filed"]);
  const second = await runModelDriftSweep({ manifest: manifest(), hf, primary: client });
  assert.deepEqual(second.findings.map((f) => f.action), ["deduped"]);
  assert.equal(store.length, 1);
});

test("a later revision diffs its files against the earlier issue's snapshot", async () => {
  const { client, store } = fakeIssues();
  await runModelDriftSweep({ manifest: manifest(), hf: fakeHf({ "acme/Chat-GGUF": info("bbb2222bbb", ["a.gguf"]) }), primary: client });
  await runModelDriftSweep({ manifest: manifest(), hf: fakeHf({ "acme/Chat-GGUF": info("ccc3333ccc", ["a.gguf", "b-IQ2.gguf"]) }), primary: client });
  assert.equal(store.length, 2);
  assert.ok(store[1].body.includes("New files since the last snapshot (1)"));
  assert.ok(store[1].body.includes("`b-IQ2.gguf`"));
});

test("unchanged pinned repo files nothing", async () => {
  const { client, store } = fakeIssues();
  const r = await runModelDriftSweep({ manifest: manifest(), hf: fakeHf({ "acme/Chat-GGUF": info("aaa1111") }), primary: client });
  assert.equal(r.findings.length, 0);
  assert.equal(store.length, 0);
});

test("new family repo files an issue; family budget caps a first-run flood", async () => {
  const hits = ["Chat-5", "Chat-5b", "Chat-5c"].map((n) => ({ id: `acme/${n}`, createdAt: "2026-10-01T00:00:00Z" }));
  const { client, store } = fakeIssues();
  const r = await runModelDriftSweep({ manifest: manifest(), hf: fakeHf({ "acme/Chat-GGUF": info("aaa1111") }, hits), primary: client });
  assert.equal(r.findings.filter((f) => f.kind === "family" && f.action === "filed").length, 2);
  assert.equal(store.length, 2);
  // Next week the third one is filed; the first two dedupe for free.
  const again = await runModelDriftSweep({ manifest: manifest(), hf: fakeHf({ "acme/Chat-GGUF": info("aaa1111") }, hits), primary: client });
  assert.deepEqual(again.findings.map((f) => f.action).sort(), ["deduped", "deduped", "filed"]);
});

test("one failing repo is an error row, not a crashed sweep", async () => {
  const m = manifest();
  m.models[0].repos.push({ repo: "acme/Gone", role: "x" });
  m.models[0].repos[0].pinnedRevision = "bbb2222bbb";
  const hf = fakeHf({ "acme/Chat-GGUF": info("bbb2222bbb"), "acme/Gone": new Error("HuggingFace -> 404") });
  const r = await runModelDriftSweep({ manifest: m, hf, primary: fakeIssues().client });
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes("acme/Gone"));
});

test("dry run reports without creating; token denied on primary falls back with a note", async () => {
  const hf = fakeHf({ "acme/Chat-GGUF": info("bbb2222bbb") });
  const a = fakeIssues();
  const dry = await runModelDriftSweep({ manifest: manifest(), hf, primary: a.client, dryRun: true });
  assert.deepEqual(dry.findings.map((f) => f.action), ["would-file"]);
  assert.equal(a.store.length, 0);

  const denied = fakeIssues("o/infra", { denied: true });
  const fb = fakeIssues("o/fallback");
  const r = await runModelDriftSweep({ manifest: manifest(), hf, primary: denied.client, fallback: fb.client });
  assert.equal(r.issueRepo, "o/fallback");
  assert.ok(fb.store[0].body.includes("could not reach `o/infra`"));
});

test("HF client parses sha/lastModified/siblings and rejects a shaless response", async () => {
  const ok = createHfClient((async () =>
    new Response(JSON.stringify({ id: "a/b", sha: "s", lastModified: "2026-10-01T00:00:00Z", siblings: [{ rfilename: "x.gguf" }] }))) as typeof fetch);
  assert.deepEqual((await ok.model("a/b")).files, ["x.gguf"]);
  const bad = createHfClient((async () => new Response("{}")) as typeof fetch);
  await assert.rejects(() => bad.model("a/b"), /no sha/);
});

test("shipped manifest is well formed: valid regexes, pins, unique ids", () => {
  const m = JSON.parse(readFileSync(new URL("../../src/config/model-watch.json", import.meta.url), "utf8")) as ModelWatchManifest;
  assert.match(m.issueRepo, /^jaewilson07\/infra-cubby$/);
  assert.equal(new Set(m.models.map((x) => x.id)).size, m.models.length);
  new RegExp(m.filePattern);
  for (const model of m.models) {
    assert.ok(model.repos.length + model.families.length > 0, model.id);
    for (const f of model.families) new RegExp(f.pattern, f.flags);
    for (const r of model.repos) {
      assert.match(r.repo, /^[^/]+\/[^/]+$/);
      if (r.pinnedRevision) assert.match(r.pinnedRevision, /^[0-9a-f]{40}$/);
    }
  }
});
