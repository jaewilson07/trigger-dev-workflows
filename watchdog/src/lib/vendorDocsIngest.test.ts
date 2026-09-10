import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VENDOR_DOCS_GIT_MIRROR_SOURCES,
  buildFailureCommentBody,
  buildFailureIssueBody,
  buildIngestRequestBody,
  buildRecoveryCommentBody,
  cleanupStaleDocuments,
  createCollection,
  ensureCollectionId,
  failureIssueLabels,
  findCollectionByName,
  ingestVendorDocsSubfolder,
  reportVendorDocsFailure,
  reportVendorDocsRecovery,
  withVendorDocsFailureReporting,
} from "./vendorDocsIngest.js";
import type { GitHubIssueClient, GitHubIssueRef, StaleDocumentsClient } from "./vendorDocsIngest.js";

// ---------------------------------------------------------------------------
// Fake fetch — records calls, replays queued responses. Same "mock fetch,
// assert on the outbound request" shape the issue's Testing Decisions ask
// for ("what request the ingest step's fetch makes (URL, headers, body)").
// ---------------------------------------------------------------------------

type FakeCall = { url: string; init?: RequestInit };

function makeFakeFetch(responses: Array<() => Response>): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const maker = responses[i++];
    if (!maker) throw new Error(`makeFakeFetch: no response queued for call #${i} (${String(input)})`);
    return maker();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Ingest request-building — collection_id is REQUIRED, never omitted.
// Dedicated assertion per the issue's Testing Decisions: "a regression here
// silently merges collections, so this is worth a dedicated assertion, not
// just incidental coverage from the general request-shape test."
// ---------------------------------------------------------------------------

test("buildIngestRequestBody always carries collection_id, for every registered source", () => {
  for (const source of VENDOR_DOCS_GIT_MIRROR_SOURCES) {
    // A source with no pre-existing collectionId (langchain-oss-docs,
    // langsmith-docs) is resolved at runtime via ensureCollectionId, not
    // read off the registry entry directly — a fake stand-in id exercises
    // the same "always carries collection_id" contract on this pure builder
    // without needing that resolution here.
    const collectionId = source.collectionId ?? "resolved-test-collection-id";
    const body = buildIngestRequestBody(source, collectionId);
    assert.equal(typeof body.collection_id, "string");
    assert.ok(body.collection_id.length > 0, `${source.id} must carry a non-empty collection_id`);
    assert.equal(body.collection_id, collectionId);
  }
});

test("buildIngestRequestBody's github_url always points at vendor-docs-sync, never a vendor's own repo", () => {
  for (const source of VENDOR_DOCS_GIT_MIRROR_SOURCES) {
    const collectionId = source.collectionId ?? "resolved-test-collection-id";
    const body = buildIngestRequestBody(source, collectionId);
    assert.equal(body.github_url, `https://github.com/jaewilson07/vendor-docs-sync/tree/main/${source.subfolder}`);
    // "Never a vendor's own repo" means never the upstream's OWNER/REPO path
    // segment specifically (e.g. github.com/langfuse/langfuse-docs) — not
    // "never contains the owner's name as a substring anywhere," which
    // false-positives the moment a subfolder is (reasonably) named after
    // the product, e.g. langfuse-docs's own owner IS literally "langfuse".
    assert.doesNotMatch(
      body.github_url,
      new RegExp(`github\\.com/${source.upstream.owner}/${source.upstream.repo}(?:/|$)`, "i")
    );
  }
});

// ---------------------------------------------------------------------------
// previous_github_url (mdrag#1447) — relocation-aware upsert. Every
// git-mirror source has an `upstream` to relocate from; a bare
// `{ subfolder }` caller (matching claude-code-docs's shape, no prior
// ingest to relocate from) must never get a fabricated one.
// ---------------------------------------------------------------------------

test("buildIngestRequestBody includes previous_github_url, scoped to each source's own upstream", () => {
  const domo = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "domo-docs")!;
  const letta = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "letta-docs")!;

  // Has a subpath — needs an explicit ref to express it at all.
  assert.equal(
    buildIngestRequestBody(domo, domo.collectionId!).previous_github_url,
    "https://github.com/DomoApps/domo-documentation-hub/tree/main/s/article"
  );
  // No subpath — bare repo root, mdrag#1447 resolves the default branch server-side.
  assert.equal(
    buildIngestRequestBody(letta, letta.collectionId!).previous_github_url,
    "https://github.com/letta-ai/letta-docs-md"
  );
});

test("buildIngestRequestBody omits previous_github_url entirely when the caller supplies no upstream (claude-code-docs's shape)", () => {
  const body = buildIngestRequestBody({ subfolder: "claude-code-docs" }, "some-collection-id");
  assert.equal("previous_github_url" in body, false);
});

test("no two sources' previous_github_url point at the same repo (each relocates from its own vendor, never a sibling's)", () => {
  const urls = VENDOR_DOCS_GIT_MIRROR_SOURCES.map(
    (s) => buildIngestRequestBody(s, s.collectionId ?? "resolved-test-collection-id").previous_github_url
  );
  assert.equal(new Set(urls).size, urls.length);
});

test("no two sources share a collection_id (the exact regression this issue fixes)", () => {
  // Only sources with a pre-existing, hand-verified collectionId are in
  // scope here — langchain-oss-docs/langsmith-docs resolve theirs at
  // runtime via ensureCollectionId and are covered by the dedicated test
  // below instead (their collectionNames, not ids, are what must stay
  // distinct at registry time).
  const ids = VENDOR_DOCS_GIT_MIRROR_SOURCES.map((s) => s.collectionId).filter((id): id is string => id !== undefined);
  assert.equal(new Set(ids).size, ids.length);
});

test("no two sources share a collectionName either (the id-less sources' own dedup key)", () => {
  const names = VENDOR_DOCS_GIT_MIRROR_SOURCES.map((s) => s.collectionName);
  assert.equal(new Set(names).size, names.length);
});

test("langchain-oss-docs, langsmith-docs, trigger-dev-docs, langfuse-docs and fastmcp-docs have no pre-existing collectionId or oldSourceUrlPrefix (no prior ingest to pin to or clean up after)", () => {
  for (const id of [
    "langchain-oss-docs",
    "langsmith-docs",
    "trigger-dev-docs",
    "langfuse-docs",
    "fastmcp-docs",
  ] as const) {
    const source = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === id)!;
    assert.equal(source.collectionId, undefined);
    assert.equal(source.oldSourceUrlPrefix, undefined);
    assert.ok(source.collectionName.length > 0);
  }
});

test("trigger-dev-docs mirrors a different upstream repo/subfolder than trigger-dev-skills (product docs vs. agent-skill definitions, never one collection)", () => {
  const docs = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "trigger-dev-docs")!;
  const skills = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "trigger-dev-skills")!;
  assert.equal(docs.upstream.owner, "triggerdotdev");
  assert.equal(docs.upstream.repo, "trigger.dev");
  assert.equal(docs.upstream.subpath, "docs");
  assert.notEqual(docs.upstream.repo, skills.upstream.repo);
  assert.notEqual(docs.subfolder, skills.subfolder);
  assert.notEqual(docs.collectionName, skills.collectionName);
});

test("langchain-oss-docs and langsmith-docs mirror distinct subpaths of the same upstream repo, into distinct subfolders", () => {
  const oss = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "langchain-oss-docs")!;
  const langsmith = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "langsmith-docs")!;
  assert.equal(oss.upstream.owner, "langchain-ai");
  assert.equal(oss.upstream.repo, "docs");
  assert.equal(langsmith.upstream.owner, "langchain-ai");
  assert.equal(langsmith.upstream.repo, "docs");
  assert.notEqual(oss.upstream.subpath, langsmith.upstream.subpath);
  assert.notEqual(oss.subfolder, langsmith.subfolder);
});

test("langfuse-docs mirrors langfuse/langfuse-docs' content/docs subpath only, not the whole content/ tree", () => {
  const source = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "langfuse-docs")!;
  assert.equal(source.upstream.owner, "langfuse");
  assert.equal(source.upstream.repo, "langfuse-docs");
  assert.equal(source.upstream.subpath, "content/docs");
});

test("fastmcp-docs is scoped to v4 — excludes the docs/v2 legacy tree so a v2 answer can't surface for a v4 question", () => {
  const source = VENDOR_DOCS_GIT_MIRROR_SOURCES.find((s) => s.id === "fastmcp-docs")!;
  assert.equal(source.upstream.owner, "PrefectHQ");
  assert.equal(source.upstream.repo, "fastmcp");
  assert.equal(source.upstream.subpath, "docs");
  assert.deepEqual(source.upstream.excludeSubpaths, ["v2"]);
  // The subfolder/collection names carry the version explicitly too — not
  // just the exclude filter — so a future v5 docs source doesn't silently
  // collide with this one.
  assert.match(source.subfolder, /v4/);
  assert.match(source.collectionName, /v4/);
});

test("ingestVendorDocsSubfolder POSTs the right URL/headers/body and returns the queued job", async () => {
  const source = VENDOR_DOCS_GIT_MIRROR_SOURCES[0]!;
  const { fetchImpl, calls } = makeFakeFetch([
    () => jsonResponse(202, { job_id: "job-123", status: "queued", status_url: "/api/v1/jobs/job-123" }),
  ]);

  const outcome = await ingestVendorDocsSubfolder(
    { subfolder: source.subfolder },
    source.collectionId!,
    "dc-test-token",
    fetchImpl
  );

  assert.deepEqual(outcome, { status: "queued", jobId: "job-123", statusUrl: "/api/v1/jobs/job-123" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://wiki.datacrew.space/api/v1/ingest/git-repo");
  assert.equal(calls[0]!.init?.method, "POST");
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer dc-test-token");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.collection_id, source.collectionId!);
  assert.equal(body.github_url, `https://github.com/jaewilson07/vendor-docs-sync/tree/main/${source.subfolder}`);
});

test("ingestVendorDocsSubfolder throws on a non-2xx response, without leaking the body", async () => {
  const source = VENDOR_DOCS_GIT_MIRROR_SOURCES[0]!;
  const { fetchImpl } = makeFakeFetch([() => new Response("server exploded", { status: 500 })]);

  await assert.rejects(
    () => ingestVendorDocsSubfolder({ subfolder: source.subfolder }, source.collectionId!, "dc-test-token", fetchImpl),
    /500/
  );
});

// ---------------------------------------------------------------------------
// Collection lookup/bootstrap (claude-code-docs only)
// ---------------------------------------------------------------------------

test("findCollectionByName returns the match, or null when absent", async () => {
  const { fetchImpl: found } = makeFakeFetch([
    () =>
      jsonResponse(200, {
        collections: [{ collection_id: "abc123", name: "repo_claude-code-docs" }],
        total: 1,
      }),
  ]);
  assert.deepEqual(await findCollectionByName("repo_claude-code-docs", "tok", found), {
    collection_id: "abc123",
    name: "repo_claude-code-docs",
  });

  const { fetchImpl: missing } = makeFakeFetch([() => jsonResponse(200, { collections: [], total: 0 })]);
  assert.equal(await findCollectionByName("repo_claude-code-docs", "tok", missing), null);
});

test("ensureCollectionId reuses an existing collection instead of creating a duplicate", async () => {
  const { fetchImpl, calls } = makeFakeFetch([
    () => jsonResponse(200, { collections: [{ collection_id: "existing-id", name: "repo_claude-code-docs" }], total: 1 }),
  ]);
  const id = await ensureCollectionId("repo_claude-code-docs", "tok", fetchImpl);
  assert.equal(id, "existing-id");
  assert.equal(calls.length, 1, "no create call when one already exists");
});

test("ensureCollectionId creates one when none exists", async () => {
  const { fetchImpl, calls } = makeFakeFetch([
    () => jsonResponse(200, { collections: [], total: 0 }),
    () => jsonResponse(201, { collection_id: "new-id", name: "repo_claude-code-docs" }),
  ]);
  const id = await ensureCollectionId("repo_claude-code-docs", "tok", fetchImpl);
  assert.equal(id, "new-id");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.init?.method, "POST");
});

test("createCollection posts the name in the body", async () => {
  const { fetchImpl, calls } = makeFakeFetch([
    () => jsonResponse(201, { collection_id: "new-id", name: "repo_claude-code-docs" }),
  ]);
  await createCollection("repo_claude-code-docs", "tok", fetchImpl);
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.name, "repo_claude-code-docs");
});

// ---------------------------------------------------------------------------
// Stale-document cleanup — mix of old/new documents; idempotent re-run.
// ---------------------------------------------------------------------------

function fakeStaleDocumentsClient(docs: Array<{ source_url: string | null }>): {
  client: StaleDocumentsClient;
  deleted: string[];
} {
  const deleted: string[] = [];
  const client: StaleDocumentsClient = {
    async listDocuments(_collectionId, page, pageSize) {
      const start = (page - 1) * pageSize;
      return { documents: docs.slice(start, start + pageSize), total: docs.length };
    },
    async deleteBySourceUrl(url) {
      deleted.push(url);
    },
  };
  return { client, deleted };
}

const OLD_PREFIX = "https://github.com/DomoApps/domo-documentation-hub/blob/";
const NEW_PREFIX = "https://github.com/jaewilson07/vendor-docs-sync/blob/main/domo-docs/";

test("cleanup deletes exactly the old-source_url documents, and none of the new ones", async () => {
  const { client, deleted } = fakeStaleDocumentsClient([
    { source_url: `${OLD_PREFIX}main/s/article/one.md` },
    { source_url: `${NEW_PREFIX}one.md` },
    { source_url: `${OLD_PREFIX}main/s/article/two.md` },
    { source_url: null },
    { source_url: `${NEW_PREFIX}two.md` },
  ]);

  const outcome = await cleanupStaleDocuments("collection-id", OLD_PREFIX, client, { dryRun: false });

  assert.equal(outcome.scanned, 5);
  assert.equal(outcome.staleFound, 2);
  assert.equal(outcome.deleted, 2);
  assert.equal(outcome.skipped, false, "a real cleanup pass is not a skipped one");
  assert.deepEqual(new Set(deleted), new Set([`${OLD_PREFIX}main/s/article/one.md`, `${OLD_PREFIX}main/s/article/two.md`]));
  assert.deepEqual(new Set(outcome.deletedUrls), new Set(deleted));
});

test("a dry run finds stale documents but deletes nothing", async () => {
  const { client, deleted } = fakeStaleDocumentsClient([
    { source_url: `${OLD_PREFIX}main/s/article/one.md` },
    { source_url: `${NEW_PREFIX}one.md` },
  ]);

  const outcome = await cleanupStaleDocuments("collection-id", OLD_PREFIX, client, { dryRun: true });

  assert.equal(outcome.staleFound, 1);
  assert.equal(outcome.deleted, 0);
  assert.deepEqual(outcome.deletedUrls, []);
  assert.deepEqual(deleted, [], "dry run must never call deleteBySourceUrl");
});

test("a second pass after cleanup already ran is a safe no-op, not an error", async () => {
  // Simulates "cleanup already ran": nothing with the old prefix remains.
  const { client, deleted } = fakeStaleDocumentsClient([
    { source_url: `${NEW_PREFIX}one.md` },
    { source_url: `${NEW_PREFIX}two.md` },
  ]);

  const outcome = await cleanupStaleDocuments("collection-id", OLD_PREFIX, client, { dryRun: false });

  assert.equal(outcome.staleFound, 0);
  assert.equal(outcome.deleted, 0);
  assert.deepEqual(deleted, []);
});

test("cleanup pages through more documents than fit on one page", async () => {
  const docs = Array.from({ length: 5 }, (_, i) => ({ source_url: `${OLD_PREFIX}main/s/article/${i}.md` }));
  const { client, deleted } = fakeStaleDocumentsClient(docs);

  const outcome = await cleanupStaleDocuments("collection-id", OLD_PREFIX, client, { dryRun: false, pageSize: 2 });

  assert.equal(outcome.scanned, 5);
  assert.equal(outcome.deleted, 5);
  assert.equal(deleted.length, 5);
});

// ---------------------------------------------------------------------------
// GitHub-issue dedup/resolve logic — mocked GitHubIssueClient, no live issue
// creation, per the issue's Testing Decisions.
// ---------------------------------------------------------------------------

function fakeGitHubIssueClient(initialOpen: GitHubIssueRef[] = []): {
  client: GitHubIssueClient;
  calls: { created: number; commented: Array<{ number: number; body: string }>; closed: number[] };
} {
  const open = [...initialOpen];
  const calls = { created: 0, commented: [] as Array<{ number: number; body: string }>, closed: [] as number[] };
  const client: GitHubIssueClient = {
    async searchOpenIssues() {
      return open;
    },
    async createIssue(_title, _body) {
      calls.created += 1;
      const issue = { number: 999, html_url: "https://github.com/jaewilson07/trigger-dev-workflows/issues/999" };
      open.push(issue);
      return issue;
    },
    async commentOnIssue(number, body) {
      calls.commented.push({ number, body });
    },
    async closeIssue(number) {
      calls.closed.push(number);
      const idx = open.findIndex((i) => i.number === number);
      if (idx !== -1) open.splice(idx, 1);
    },
  };
  return { client, calls };
}

test("failureIssueLabels always includes the shared label plus the source-specific one", () => {
  assert.deepEqual(failureIssueLabels("domo-docs"), ["bug", "automation", "vendor-docs-sync", "domo-docs"]);
});

test("reportVendorDocsFailure creates a new issue when none is open", async () => {
  const { client, calls } = fakeGitHubIssueClient([]);
  const result = await reportVendorDocsFailure("domo-docs", "boom", "run_abc", client);
  assert.equal(result.action, "created");
  assert.equal(calls.created, 1);
  assert.equal(calls.commented.length, 0);
});

test("reportVendorDocsFailure comments on an existing open issue instead of duplicating it", async () => {
  const existing = { number: 42, html_url: "https://github.com/jaewilson07/trigger-dev-workflows/issues/42" };
  const { client, calls } = fakeGitHubIssueClient([existing]);
  const result = await reportVendorDocsFailure("domo-docs", "boom again", "run_def", client);
  assert.equal(result.action, "commented");
  assert.equal(result.issue.number, 42);
  assert.equal(calls.created, 0);
  assert.equal(calls.commented.length, 1);
  assert.equal(calls.commented[0]!.number, 42);
});

test("reportVendorDocsRecovery is a no-op when nothing is open", async () => {
  const { client, calls } = fakeGitHubIssueClient([]);
  const result = await reportVendorDocsRecovery("domo-docs", "run_ghi", client);
  assert.equal(result.action, "none");
  assert.equal(calls.closed.length, 0);
});

test("reportVendorDocsRecovery comments and closes an open failure issue on success", async () => {
  const existing = { number: 7, html_url: "https://github.com/jaewilson07/trigger-dev-workflows/issues/7" };
  const { client, calls } = fakeGitHubIssueClient([existing]);
  const result = await reportVendorDocsRecovery("domo-docs", "run_jkl", client);
  assert.equal(result.action, "closed");
  assert.equal(calls.commented.length, 1);
  assert.deepEqual(calls.closed, [7]);
});

test("buildFailureIssueBody and buildFailureCommentBody surface the error, timestamp, and run", () => {
  const ctx = { sourceId: "domo-docs" as const, error: "boom", timestamp: "2026-09-02T00:00:00.000Z", runId: "run_1" };
  assert.match(buildFailureIssueBody(ctx), /boom/);
  assert.match(buildFailureIssueBody(ctx), /run_1/);
  assert.match(buildFailureCommentBody(ctx), /boom/);
});

test("buildRecoveryCommentBody names the source", () => {
  assert.match(buildRecoveryCommentBody("letta-docs", "run_2"), /letta-docs/);
});

// ---------------------------------------------------------------------------
// withVendorDocsFailureReporting — the glue: success closes, failure
// files/comments and always re-throws the original error.
// ---------------------------------------------------------------------------

test("on success, withVendorDocsFailureReporting resolves and best-effort-closes an open issue", async () => {
  const existing = { number: 5, html_url: "https://github.com/jaewilson07/trigger-dev-workflows/issues/5" };
  const { client, calls } = fakeGitHubIssueClient([existing]);
  const result = await withVendorDocsFailureReporting("domo-docs", "unused-token", "run_ok", async () => "done", client);
  assert.equal(result, "done");
  assert.equal(calls.closed.length, 1);
});

test("on failure, withVendorDocsFailureReporting reports it and re-throws the ORIGINAL error", async () => {
  const { client, calls } = fakeGitHubIssueClient([]);
  const boom = new Error("mirror step exploded");
  await assert.rejects(
    () =>
      withVendorDocsFailureReporting(
        "domo-docs",
        "unused-token",
        "run_fail",
        async () => {
          throw boom;
        },
        client
      ),
    (err: unknown) => err === boom
  );
  assert.equal(calls.created, 1);
});
