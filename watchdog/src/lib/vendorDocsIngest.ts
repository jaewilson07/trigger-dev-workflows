import { VENDOR_DOCS_SYNC_OWNER, VENDOR_DOCS_SYNC_REPO } from "./vendorDocsMirrorCore.js";
import type { GitMirrorUpstream } from "./vendorDocsMirrorCore.js";

/**
 * Common ingest step (POST mdrag `/ingest/git-repo`), the stale-document
 * cutover cleanup, and GitHub-issue-on-failure/recovery handling shared by
 * every vendor-docs-sync task — jaewilson07/trigger-dev-workflows#128.
 *
 * ## Auth — `DATACREW_API_TOKEN` (a Bearer token, wire shape unchanged
 * regardless of kind), matching Decision 2 in the original `domoDocsIngest.ts`
 * (preserved here per the issue's User Story 16): `X-Internal-Secret`/
 * `INTERNAL_SECRET` is a pure string-compare with no host/network check,
 * doesn't exist in Infisical outside bonker's local `.env`, and —
 * decisively — a Trigger.dev task runs off-host with no Docker access to
 * read it in the first place. `DATACREW_API_TOKEN` is the documented,
 * already-portable path (`mdrag/docs/capabilities/
 * calling-mdrag-from-agents.md`), already used by every other off-host
 * caller. No `x-user-email` header either — mdrag's Next.js proxy
 * (`frontend/app/api/v1/[...path]/route.ts`) strips it unconditionally from
 * any Bearer-authenticated request (see jaewilson07/trigger-dev-workflows#36)
 * — ownership of each source's collection is fixed at first insert via
 * `ensure_repo_collection`'s `$setOnInsert` / `create_collection`'s caller,
 * not derived from a header mdrag will never honor on this path.
 *
 * **Credential KIND, corrected 2026-09-02** — this env var originally held a
 * `dc_` JWT (a personal datacrew.space service token). mdrag#1331 gave mdrag
 * its own, mdrag-only credential family, `mdrag_access_token` (wire prefix
 * `mat_`), explicitly meant for exactly this kind of long-lived automation —
 * "the same shape as trigger.dev issuing its own per-project secret keys"
 * (mdrag#1315). The `dc_` token this pipeline held went stale (revoked
 * server-side on datacrew.space, independent of mdrag) and 401'd with
 * "Invalid or expired token"; the fix was minting a dedicated
 * `vendor-docs-sync@datacrew.space` mdrag identity and putting its `mat_`
 * token in this SAME env var — no code change needed, mdrag's
 * `ApiKeyMiddleware` auto-detects the `mat_` prefix. See mdrag's
 * `authenticate-to-mdrag` skill (`.agents/skills/authenticate-to-mdrag/`)
 * before changing this again — a `dc_`-token-shaped fix is very likely wrong
 * for this caller now.
 *
 * ## Collection scoping — load-bearing (Implementation Decisions, "Collection
 * collapse")
 *
 * `GitRepoIngestRequest.collection_id` is real but unused before this issue.
 * Left unset, mdrag auto-derives a collection from `GitRepoTarget.slug`
 * (`{owner}-{repo}`, e.g. `jaewilson07-vendor-docs-sync`) — the subpath is
 * NOT part of it. Every one of the four `vendor-docs-sync/<vendor>/`
 * ingests targets the SAME `owner/repo`
 * (`jaewilson07/vendor-docs-sync`), so leaving `collection_id` unset would
 * merge Domo/Letta/Trigger.dev-skills/Claude docs into one collection.
 * `VENDOR_DOCS_GIT_MIRROR_SOURCES` below carries each source's EXISTING
 * collection_id, confirmed live (not recomputed by hand) against
 * `GET /api/v1/collections` on 2026-09-02 — see the doc comment on each
 * entry. `buildIngestRequestBody` always sets `collection_id`, and
 * `vendorDocsIngest.test.ts` asserts it is never omitted, exactly per the
 * issue's Testing Decisions (a regression here silently merges collections).
 *
 * ## Stale-document cleanup — load-bearing (Implementation Decisions,
 * "Stale duplicates on cutover")
 *
 * Each document's `source_url` is a `blob/<ref>/<path>` URL rooted at
 * whichever `owner/repo` the ingest call targeted (confirmed against
 * `git_repo.py`'s `clone_and_collect_git_repo`). Moving domo-docs/
 * letta-docs/trigger-dev-skills from "ingest the vendor's repo directly" to
 * "ingest vendor-docs-sync" changes every document's `source_url` for
 * identical content, so mdrag's upsert-on-`source_url` (ADR-0016) does not
 * recognize the new ingest as replacing the old ones — without cleanup the
 * old documents sit stale forever next to the new ones.
 * `cleanupStaleDocuments` enumerates each cutover source's OLD-prefix
 * documents (via `GET /documents?collection_id=`, paginated) and deletes
 * them via the real `DELETE /documents/by-source-url` endpoint (confirmed in
 * `documents/router.py` — mdrag has no MCP delete *tool*, but does have this
 * REST route).
 *
 * `isStaleCleanupLive()` gates the delete path behind an explicit env var,
 * defaulting to a list-only dry run — per the issue's Testing Decisions, "one
 * real manual dry-run (list-only, no delete) against production before its
 * delete path is ever allowed to run live". A human flips
 * `VENDOR_DOCS_STALE_CLEANUP_LIVE=true` on the deployed environment only
 * after reviewing that dry run's logged output.
 *
 * `cleanupStaleDocuments` itself is safe to call repeatedly (a second pass
 * over an already-cleaned collection finds zero stale documents and deletes
 * nothing), but the issue specifies "a one-time run, after its first
 * successful vendor-docs-sync-sourced ingest" — not a live-delete-capable
 * full-collection scan on every scheduled run forever (real API load, and a
 * needlessly wide window for an irreversible delete path to be live). The
 * caller (`vendorDocsMirror.ts`'s `isStaleCleanupDone`/`markStaleCleanupDone`,
 * an Infisical-backed flag per source, same durable-state shape as
 * `domoDocsReport.ts`'s SHA cache) enforces the actual once-only behavior:
 * skip cleanup entirely once a prior LIVE run has completed successfully.
 * `cleanupStaleDocuments`'s own idempotency stays as defense in depth, not
 * the thing doing the gating.
 *
 * ## Relocation-aware upsert — `previous_github_url` (jaewilson07/mdrag#1447,
 * ADR-0038 addendum), added after the cutover above already shipped
 *
 * mdrag#1447 exposed `document_upsert.upsert_document`'s relocation hint
 * (mdrag#1440) on `POST /ingest/git-repo` itself: pass `previous_github_url`
 * (same shape as `github_url`) and mdrag computes each collected file's OLD
 * `source_url` server-side — `base_url + relative_path` against the OLD
 * repo, the exact same construction it already uses for the NEW one — and
 * a match UPDATES the existing document in place (archived, not
 * duplicated) instead of leaving it stale for `cleanupStaleDocuments` to
 * find and delete later. `buildIngestRequestBody` now includes it for every
 * git-mirror source (`source.upstream` is exactly the OLD location the
 * mirror step already clones FROM) — verified end-to-end this session that
 * relative paths survive the mirror unchanged, which is the one precondition
 * this relies on. `claude-code-docs` has no `upstream` (no prior ingest to
 * relocate from), so it never gets this field — `buildIngestRequestBody`
 * only includes `previous_github_url` when the caller supplies `upstream`.
 *
 * This narrows what `cleanupStaleDocuments` is actually for going forward:
 * a relocated file now upserts in place and never needs the delete path at
 * all; only a file removed from the upstream tree entirely (present in the
 * OLD ingest, absent from the new one) has no NEW file to trigger a
 * relocation-update and would still need the delete path to retire it.
 * Left `cleanupStaleDocuments`/`isStaleCleanupLive` wired exactly as before
 * on that narrower basis rather than removing it — deliberately not
 * re-litigated in this change.
 */

export const MDRAG_API_URL = process.env.MDRAG_API_URL ?? "https://wiki.datacrew.space";

const REQUEST_USER_AGENT = "datacrew-watchdog-vendor-docs-sync";

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

export type VendorDocsSourceId =
  | "domo-docs"
  | "letta-docs"
  | "trigger-dev-skills"
  | "claude-code-docs"
  | "langchain-oss-docs"
  | "langsmith-docs"
  | "trigger-dev-docs"
  | "langfuse-docs"
  | "fastmcp-docs"
  | "comfyui-docs";

export type VendorDocsGitMirrorSourceConfig = {
  id: VendorDocsSourceId;
  subfolder: string;
  upstream: GitMirrorUpstream;
  /**
   * Existing mdrag collection_id — see "Collection scoping" above. Omitted
   * only for a source with no prior ingest to pin to (langchain-oss-docs,
   * langsmith-docs, trigger-dev-docs, langfuse-docs, fastmcp-docs,
   * comfyui-docs — each new with no prior direct-upstream ingest, same
   * reasoning as claude-code-docs' crawl-mirror source below): `runVendorDocsGitMirrorTask`
   * falls back to `ensureCollectionId(collectionName, ...)` for those,
   * resolving-or-creating by name at runtime instead of trusting a
   * hand-computed id.
   */
  collectionId?: string;
  collectionName: string;
  /**
   * Prefix of every `source_url` this collection's documents carried under
   * the OLD (direct-upstream) ingest shape — e.g.
   * `https://github.com/DomoApps/domo-documentation-hub/blob/`. Ref-agnostic
   * (no branch name baked in) since `git_repo.py` resolves the default
   * branch dynamically and this must match regardless of which ref an old
   * ingest happened to run against. Omitted for a source with no prior
   * ingest to migrate away from (same set as `collectionId` above) —
   * `runVendorDocsGitMirrorTask` skips the cutover-cleanup step entirely
   * when this is absent, matching how claude-code-docs' crawl-mirror task
   * never runs cleanup at all.
   */
  oldSourceUrlPrefix?: string;
  tags: string[];
};

/**
 * Collection ids verified live against `GET /api/v1/collections` on
 * 2026-09-02 (owner `jae@datacrew.space`, matching `domoDocsIngest.ts`'s
 * existing collection-ownership note) — NOT recomputed by hand from
 * `GitRepoTarget.slug`, per the issue's explicit instruction not to assume a
 * hand-computed slug matches what mdrag actually has stored. They happen to
 * equal the auto-derived `repo_<owner>-<repo>` slug here (mdrag has never
 * been pointed at anything but each vendor's own root/subpath before), which
 * is exactly why passing them explicitly matters: the moment the ingest
 * target moves to `vendor-docs-sync/<vendor>/`, the auto-derived slug would
 * silently change to `repo_jaewilson07-vendor-docs-sync` for all four
 * sources — this registry is what keeps each source pinned to its real,
 * pre-existing collection instead.
 */
export const VENDOR_DOCS_GIT_MIRROR_SOURCES: VendorDocsGitMirrorSourceConfig[] = [
  {
    id: "domo-docs",
    subfolder: "domo-docs",
    upstream: { owner: "DomoApps", repo: "domo-documentation-hub", subpath: "s/article" },
    collectionId: "6a5fb8423186422957a29fbc",
    collectionName: "repo_domoapps-domo-documentation-hub",
    oldSourceUrlPrefix: "https://github.com/DomoApps/domo-documentation-hub/blob/",
    tags: ["domo-docs", "vendor-docs-sync", "ingest", "mdrag"],
  },
  {
    id: "letta-docs",
    subfolder: "letta-docs",
    upstream: { owner: "letta-ai", repo: "letta-docs-md" },
    collectionId: "6a6abfafbf6aec5e01c6c1a3",
    collectionName: "repo_letta-ai-letta-docs-md",
    oldSourceUrlPrefix: "https://github.com/letta-ai/letta-docs-md/blob/",
    tags: ["letta-docs", "vendor-docs-sync", "ingest", "mdrag"],
  },
  {
    id: "trigger-dev-skills",
    subfolder: "trigger-dev-skills",
    upstream: { owner: "triggerdotdev", repo: "skills" },
    collectionId: "6a6ad7f4bf6aec5e01c6c1a4",
    collectionName: "repo_triggerdotdev-skills",
    oldSourceUrlPrefix: "https://github.com/triggerdotdev/skills/blob/",
    tags: ["trigger-dev-skills", "vendor-docs-sync", "ingest", "mdrag"],
  },
  {
    // LangChain's docs.langchain.com is built from langchain-ai/docs
    // (Mintlify, confirmed via that site's "Edit this page on GitHub"
    // footer link), split into two independent products under src/ —
    // oss/ (LangChain/LangGraph/Deep Agents/integrations) and langsmith/
    // (a separate observability product, self-hostable as an Enterprise
    // add-on). Two sources, not one, so each gets its own mdrag collection
    // rather than merging two products' docs together (same "collection
    // collapse" reasoning as the top doc comment's subpath note). Neither
    // has a prior direct-upstream ingest to migrate from, so — like
    // claude-code-docs — no collectionId/oldSourceUrlPrefix here;
    // `runVendorDocsGitMirrorTask` resolves-or-creates the collection by
    // name and skips cutover cleanup.
    id: "langchain-oss-docs",
    subfolder: "langchain-oss-docs",
    upstream: { owner: "langchain-ai", repo: "docs", subpath: "src/oss" },
    collectionName: "repo_langchain-ai-docs-oss",
    tags: ["langchain-docs", "vendor-docs-sync", "ingest", "mdrag"],
  },
  {
    id: "langsmith-docs",
    subfolder: "langsmith-docs",
    upstream: { owner: "langchain-ai", repo: "docs", subpath: "src/langsmith" },
    collectionName: "repo_langchain-ai-docs-langsmith",
    tags: ["langsmith-docs", "vendor-docs-sync", "ingest", "mdrag"],
  },
  {
    // docs.trigger.dev is built from triggerdotdev/trigger.dev's own `docs/`
    // subpath (Mintlify, same "trust the site's real source, not a guessed
    // repo" reasoning as langchain-oss-docs/langsmith-docs above — confirmed
    // via that repo's docs/docs.json Mintlify config and README). Distinct
    // from the existing `trigger-dev-skills` source: that one mirrors
    // triggerdotdev/skills (AI agent-skill definitions for writing
    // Trigger.dev tasks), not the product's own reference docs — the two
    // must not collapse into one collection. No prior direct-upstream
    // ingest for this source either, so — same as langchain-oss-docs/
    // langsmith-docs — no collectionId/oldSourceUrlPrefix here.
    id: "trigger-dev-docs",
    subfolder: "trigger-dev-docs",
    upstream: { owner: "triggerdotdev", repo: "trigger.dev", subpath: "docs" },
    collectionName: "repo_triggerdotdev-trigger-dev-docs",
    tags: ["trigger-dev-docs", "vendor-docs-sync", "ingest", "mdrag"],
  },
  {
    // docs.langfuse.com is built from langfuse/langfuse-docs (confirmed via
    // that site's github.com link footer), a dedicated docs repo (not a
    // subpath of the main langfuse/langfuse monorepo). Its `content/`
    // directory holds several site sections (docs, blog, changelog,
    // integrations, ...); only `content/docs` is mirrored — the technical
    // reference, same scoping as trigger-dev-docs' `docs`-subpath-only
    // choice, not blog/changelog/marketing.
    //
    // Motivated by ADR-049 (this repo's own decision that self-hosted
    // Langfuse is the intended future agentic-tracing layer, not yet
    // built) turning up no real Langfuse documentation in the KB — only
    // this repo's own ADRs mentioning Langfuse by name as a comparison
    // point, which made `query_rag` conflate Langfuse with the newly
    // ingested LangSmith docs on a "Langfuse" query (semantic-similarity
    // cross-contamination between two same-domain products, not a real
    // hit) — jaewilson07/trigger-dev-workflows#161.
    id: "langfuse-docs",
    subfolder: "langfuse-docs",
    upstream: { owner: "langfuse", repo: "langfuse-docs", subpath: "content/docs" },
    collectionName: "repo_langfuse-langfuse-docs",
    tags: ["langfuse-docs", "vendor-docs-sync", "ingest", "mdrag"],
  },
  {
    // gofastmcp.com is built from PrefectHQ/fastmcp's own `docs` subpath
    // (Mintlify — confirmed via that repo's docs/docs.json). Pinned to the
    // v4 docs specifically (the "_v4" in the id/subfolder is deliberate,
    // not decorative): `docs/` also still carries a full `docs/v2/` legacy
    // tree (81 markdown files) kept in-tree for existing v2 users, and
    // mirroring both would let a v2-era answer surface uncited for a v4
    // question — the same "don't collapse two things that must stay
    // distinguishable" reasoning as every other multi-subtree source
    // above, but solved with `excludeSubpaths` since this is one version
    // superseding another in the SAME collection, not two products that
    // need separate collections.
    id: "fastmcp-docs",
    subfolder: "fastmcp-docs-v4",
    upstream: { owner: "PrefectHQ", repo: "fastmcp", subpath: "docs", excludeSubpaths: ["v2"] },
    collectionName: "repo_prefecthq-fastmcp-docs-v4",
    tags: ["fastmcp-docs", "vendor-docs-sync", "ingest", "mdrag"],
  },
  {
    // docs.comfy.org is built from Comfy-Org/docs (Mintlify — confirmed via
    // that site's docs.json). No `subpath`: the whole repo IS the docs site
    // (content lives at repo root, not nested under a `docs/` folder), same
    // shape as letta-docs/trigger-dev-skills.
    //
    // `excludeSubpaths` drops four kinds of noise the markdown-only filter
    // (#154) alone can't tell apart from real docs, all markdown too:
    //   - ja/, ko/, zh/  — full-tree machine/community translations of the
    //     SAME English content (~17MB combined, more than double the real
    //     English corpus) — mirroring them would flood retrieval with
    //     non-English duplicates of pages already covered in English.
    //   - cloud/, cloud-nodes/, account/, router-schemas/,
    //     comfy-router-*.mdx — Comfy Cloud's hosted product, not the
    //     self-hosted local ComfyUI instance this fleet actually runs
    //     (see cubby topology notes) — answering a self-hosted question
    //     with cloud-product docs would be actively wrong, not just noise.
    //   - .github/, .cursor/, .claude/, .notes/ — repo tooling config, not
    //     documentation content.
    // What's kept: built-in-nodes/ (1028 files — the node reference),
    // custom-nodes/, interface/, basic-concepts/, installation/,
    // development/, troubleshooting/, tutorials/, specs/, comfy-cli/,
    // registry/, manager/, get_started/, api-reference/, agent-tools/
    // (literally about AI agents driving ComfyUI) — ~1825 files / 7.7MB.
    id: "comfyui-docs",
    subfolder: "comfyui-docs",
    upstream: {
      owner: "Comfy-Org",
      repo: "docs",
      excludeSubpaths: [
        "ja",
        "ko",
        "zh",
        "cloud",
        "cloud-nodes",
        "account",
        "router-schemas",
        "comfy-router-limitations.mdx",
        "comfy-router-quickstart.mdx",
        "comfy-router-reference.mdx",
        ".github",
        ".cursor",
        ".claude",
        ".notes",
      ],
    },
    collectionName: "repo_comfy-org-docs",
    tags: ["comfyui-docs", "vendor-docs-sync", "ingest", "mdrag"],
  },
];

export type VendorDocsCrawlMirrorSourceConfig = {
  id: "claude-code-docs";
  subfolder: "claude-code-docs";
  /**
   * No pre-existing collection (no prior ingest — Claude Code docs have
   * never been synced before this issue), so there's no id to verify live.
   * `ensureCollectionId` resolves-or-creates it by this name at runtime, on
   * the first real production run — never invoked by this build.
   */
  collectionName: string;
  tags: string[];
};

export const VENDOR_DOCS_CLAUDE_CODE_DOCS_SOURCE: VendorDocsCrawlMirrorSourceConfig = {
  id: "claude-code-docs",
  subfolder: "claude-code-docs",
  collectionName: "repo_claude-code-docs",
  tags: ["claude-code-docs", "vendor-docs-sync", "ingest", "mdrag"],
};

// ---------------------------------------------------------------------------
// Common ingest step
// ---------------------------------------------------------------------------

export type IngestRequestBody = {
  github_url: string;
  collection_id: string;
  previous_github_url?: string;
};

/**
 * Same shape `github_url` itself uses: a bare repo root when `upstream` has
 * no `subpath` (mdrag#1447 resolves the default branch server-side via a
 * lightweight `git ls-remote`, no ref needed here), or an explicit
 * `tree/main/<subpath>` when it does — a ref is required to express a
 * subpath at all (`parse_github_url`'s subpath capture nests under the ref
 * group), so this hardcodes `main` for that case, matching `github_url`'s
 * own hardcoded `main` for the new location.
 */
function buildPreviousGithubUrl(upstream: GitMirrorUpstream): string {
  const base = `https://github.com/${upstream.owner}/${upstream.repo}`;
  return upstream.subpath ? `${base}/tree/main/${upstream.subpath}` : base;
}

/**
 * Pure — builds the exact request body `ingestVendorDocsSubfolder` sends.
 * `collection_id` is REQUIRED (not optional) on this type on purpose: a
 * caller cannot construct a well-typed body without it, and
 * `vendorDocsIngest.test.ts` additionally asserts it's always populated with
 * the source's real id, never omitted — see this file's top doc comment.
 *
 * `previous_github_url` (mdrag#1447) is included only when the caller
 * supplies `upstream` — the git-mirror sources always have one (it's the
 * location the mirror step itself clones FROM); `claude-code-docs` has none
 * (no prior ingest to relocate from) and must never get a fabricated value.
 */
export function buildIngestRequestBody(
  source: { subfolder: string; upstream?: GitMirrorUpstream },
  collectionId: string
): IngestRequestBody {
  return {
    github_url: `https://github.com/${VENDOR_DOCS_SYNC_OWNER}/${VENDOR_DOCS_SYNC_REPO}/tree/main/${source.subfolder}`,
    collection_id: collectionId,
    ...(source.upstream ? { previous_github_url: buildPreviousGithubUrl(source.upstream) } : {}),
  };
}

export type IngestOutcome = {
  status: "queued";
  jobId: string;
  statusUrl: string;
};

/** POSTs mdrag's `/ingest/git-repo` for one source's subfolder. `fetchImpl` is injectable for tests. */
export async function ingestVendorDocsSubfolder(
  source: { subfolder: string; upstream?: GitMirrorUpstream },
  collectionId: string,
  dcToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<IngestOutcome> {
  const body = buildIngestRequestBody(source, collectionId);
  const response = await fetchImpl(`${MDRAG_API_URL}/api/v1/ingest/git-repo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${dcToken}`,
      "User-Agent": REQUEST_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`mdrag ingest/git-repo returned ${response.status}: ${bodyText.slice(-500)}`);
  }
  const job = (await response.json()) as { job_id: string; status: string; status_url: string };
  return { status: "queued", jobId: job.job_id, statusUrl: job.status_url };
}

// ---------------------------------------------------------------------------
// Collection lookup/bootstrap — claude-code-docs only (no pre-existing id)
// ---------------------------------------------------------------------------

export type MdragCollection = { collection_id: string; name: string };

export async function findCollectionByName(
  name: string,
  dcToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<MdragCollection | null> {
  const res = await fetchImpl(`${MDRAG_API_URL}/api/v1/collections`, {
    headers: { Authorization: `Bearer ${dcToken}`, "User-Agent": REQUEST_USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`mdrag collections list returned ${res.status}`);
  }
  const data = (await res.json()) as { collections: MdragCollection[] };
  return data.collections.find((c) => c.name === name) ?? null;
}

export async function createCollection(
  name: string,
  dcToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<MdragCollection> {
  const res = await fetchImpl(`${MDRAG_API_URL}/api/v1/collections`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${dcToken}`,
      "User-Agent": REQUEST_USER_AGENT,
    },
    body: JSON.stringify({
      name,
      description: `Auto-created by vendorDocsIngest.ts for vendor-docs-sync/${name.replace(/^repo_/, "")} — jaewilson07/trigger-dev-workflows#128`,
    }),
  });
  if (!res.ok) {
    throw new Error(`mdrag collections create returned ${res.status}`);
  }
  return (await res.json()) as MdragCollection;
}

/** Resolve-or-create a collection by name. Only claude-code-docs needs this — every other source has a verified pre-existing id (see the registry above). */
export async function ensureCollectionId(
  name: string,
  dcToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const existing = await findCollectionByName(name, dcToken, fetchImpl);
  if (existing) return existing.collection_id;
  const created = await createCollection(name, dcToken, fetchImpl);
  return created.collection_id;
}

// ---------------------------------------------------------------------------
// Stale-document cleanup (cutover only — domo/letta/trigger-dev-skills)
// ---------------------------------------------------------------------------

export type StaleDocumentsClient = {
  listDocuments(
    collectionId: string,
    page: number,
    pageSize: number
  ): Promise<{ documents: Array<{ source_url: string | null }>; total: number }>;
  deleteBySourceUrl(sourceUrl: string): Promise<void>;
};

export type CleanupOutcome = {
  scanned: number;
  staleFound: number;
  deleted: number;
  deletedUrls: string[];
  dryRun: boolean;
  /**
   * True when the caller short-circuited this run because a prior LIVE pass
   * already completed for this source — `scanned`/`staleFound`/`deleted` are
   * all 0 and meaningless in that case, not "the collection was scanned and
   * found clean" (see `vendorDocsTasks.ts`'s `runVendorDocsGitMirrorTask`,
   * which is what actually skips the call rather than this function).
   */
  skipped: boolean;
};

/**
 * Enumerates `collectionId`'s documents, finds every `source_url` still
 * carrying the OLD (pre-cutover) prefix, and — unless `dryRun` — deletes
 * each one. Idempotent if called again (a second pass over an already-cleaned
 * collection finds zero stale documents and deletes nothing), but the real
 * once-only behavior is enforced by the caller skipping this function
 * entirely after a successful live run — see the top doc comment's
 * "Stale-document cleanup" section.
 */
export async function cleanupStaleDocuments(
  collectionId: string,
  oldSourceUrlPrefix: string,
  client: StaleDocumentsClient,
  opts: { dryRun: boolean; pageSize?: number }
): Promise<CleanupOutcome> {
  const pageSize = opts.pageSize ?? 100;
  let page = 1;
  let scanned = 0;
  const staleUrls: string[] = [];

  // Bounded by `total` returned from the first page — a collection cannot
  // grow unboundedly mid-loop in a way that would spin this forever, but cap
  // at a generous number of pages anyway as a hard backstop against a
  // pagination bug looping forever on a live collection.
  for (let guard = 0; guard < 1000; guard++) {
    const { documents, total } = await client.listDocuments(collectionId, page, pageSize);
    scanned += documents.length;
    for (const doc of documents) {
      if (doc.source_url && doc.source_url.startsWith(oldSourceUrlPrefix)) {
        staleUrls.push(doc.source_url);
      }
    }
    if (documents.length === 0 || page * pageSize >= total) break;
    page += 1;
  }

  const deletedUrls: string[] = [];
  if (!opts.dryRun) {
    for (const url of staleUrls) {
      await client.deleteBySourceUrl(url);
      deletedUrls.push(url);
    }
  }

  return {
    scanned,
    staleFound: staleUrls.length,
    deleted: deletedUrls.length,
    deletedUrls,
    dryRun: opts.dryRun,
    skipped: false,
  };
}

export function createMdragStaleDocumentsClient(
  dcToken: string,
  fetchImpl: typeof fetch = fetch
): StaleDocumentsClient {
  return {
    async listDocuments(collectionId, page, pageSize) {
      const url = `${MDRAG_API_URL}/api/v1/documents?collection_id=${encodeURIComponent(collectionId)}&page=${page}&page_size=${pageSize}`;
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${dcToken}`, "User-Agent": REQUEST_USER_AGENT },
      });
      if (!res.ok) {
        throw new Error(`mdrag documents list returned ${res.status}`);
      }
      return (await res.json()) as { documents: Array<{ source_url: string | null }>; total: number };
    },
    async deleteBySourceUrl(sourceUrl) {
      const url = `${MDRAG_API_URL}/api/v1/documents/by-source-url?url=${encodeURIComponent(sourceUrl)}`;
      const res = await fetchImpl(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${dcToken}`, "User-Agent": REQUEST_USER_AGENT },
      });
      // A document already gone (a prior partial run deleted it, or it never
      // existed) is not an error for a cleanup step whose whole point is
      // idempotent re-running.
      if (!res.ok && res.status !== 404) {
        throw new Error(`mdrag delete by-source-url returned ${res.status}`);
      }
    },
  };
}

/**
 * Safety gate for the cleanup step's DELETE path (Testing Decisions: "one
 * real manual dry-run against production before its delete path is ever
 * allowed to run live"). Defaults to dry-run (list-only) — a human sets
 * `VENDOR_DOCS_STALE_CLEANUP_LIVE=true` on the deployed environment only
 * after reviewing a dry run's logged output.
 */
export function isStaleCleanupLive(): boolean {
  return process.env.VENDOR_DOCS_STALE_CLEANUP_LIVE === "true";
}

// ---------------------------------------------------------------------------
// GitHub-issue-on-failure / recovery
// ---------------------------------------------------------------------------

/** Nearest enclosing repo to the TASKS (the failure is in the sync task, not the mirrored content) — docs/agents/issue-tracker.md. */
export const FAILURE_ISSUE_REPO = "jaewilson07/trigger-dev-workflows";
const FAILURE_ISSUE_BASE_LABELS = ["bug", "automation", "vendor-docs-sync"];

export function failureIssueLabels(sourceId: VendorDocsSourceId): string[] {
  return [...FAILURE_ISSUE_BASE_LABELS, sourceId];
}

export function buildFailureIssueTitle(sourceId: VendorDocsSourceId): string {
  return `vendor-docs-sync: ${sourceId} ingest failing`;
}

type FailureContext = {
  sourceId: VendorDocsSourceId;
  error: string;
  timestamp: string;
  runId: string | null;
};

export function buildFailureIssueBody(ctx: FailureContext): string {
  return [
    `**Source:** ${ctx.sourceId}`,
    `**Error:** ${ctx.error}`,
    `**Timestamp:** ${ctx.timestamp}`,
    `**Run:** ${ctx.runId ?? "(no run id available)"}`,
    "",
    "Filed automatically by `watchdog/src/lib/vendorDocsIngest.ts` — jaewilson07/trigger-dev-workflows#128.",
  ].join("\n");
}

export function buildFailureCommentBody(ctx: FailureContext): string {
  return [
    `Another failure on \`${ctx.sourceId}\`:`,
    "",
    `**Error:** ${ctx.error}`,
    `**Timestamp:** ${ctx.timestamp}`,
    `**Run:** ${ctx.runId ?? "(no run id available)"}`,
  ].join("\n");
}

export function buildRecoveryCommentBody(sourceId: VendorDocsSourceId, runId: string | null): string {
  return `\`${sourceId}\` vendor-docs-sync run succeeded${runId ? ` (run ${runId})` : ""} — closing.`;
}

export type GitHubIssueRef = { number: number; html_url: string };

export type GitHubIssueClient = {
  searchOpenIssues(labels: string[]): Promise<GitHubIssueRef[]>;
  createIssue(title: string, body: string, labels: string[]): Promise<GitHubIssueRef>;
  commentOnIssue(number: number, body: string): Promise<void>;
  closeIssue(number: number): Promise<void>;
};

/**
 * Dedup/resolve logic (pure orchestration over `GitHubIssueClient` — no
 * network of its own, so tests can mock the client per the issue's Testing
 * Decisions: "existing open issue -> comment; none open -> create").
 */
export async function reportVendorDocsFailure(
  sourceId: VendorDocsSourceId,
  error: string,
  runId: string | null,
  client: GitHubIssueClient
): Promise<{ action: "created" | "commented"; issue: GitHubIssueRef }> {
  const labels = failureIssueLabels(sourceId);
  const open = await client.searchOpenIssues(labels);
  const ctx: FailureContext = { sourceId, error, timestamp: new Date().toISOString(), runId };

  if (open.length > 0) {
    const target = open[0]!;
    await client.commentOnIssue(target.number, buildFailureCommentBody(ctx));
    return { action: "commented", issue: target };
  }

  const created = await client.createIssue(
    buildFailureIssueTitle(sourceId),
    buildFailureIssueBody(ctx),
    labels
  );
  return { action: "created", issue: created };
}

/** "success after failure -> resolve" per the Testing Decisions. No-op when no open issue exists. */
export async function reportVendorDocsRecovery(
  sourceId: VendorDocsSourceId,
  runId: string | null,
  client: GitHubIssueClient
): Promise<{ action: "closed" | "none"; issue?: GitHubIssueRef }> {
  const labels = failureIssueLabels(sourceId);
  const open = await client.searchOpenIssues(labels);
  if (open.length === 0) {
    return { action: "none" };
  }
  const target = open[0]!;
  await client.commentOnIssue(target.number, buildRecoveryCommentBody(sourceId, runId));
  await client.closeIssue(target.number);
  return { action: "closed", issue: target };
}

export function createGitHubIssueClient(
  ghToken: string,
  fetchImpl: typeof fetch = fetch
): GitHubIssueClient {
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": REQUEST_USER_AGENT,
  };

  return {
    async searchOpenIssues(labels) {
      const q = `repo:${FAILURE_ISSUE_REPO} state:open ${labels.map((l) => `label:"${l}"`).join(" ")}`;
      const res = await fetchImpl(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}`, {
        headers,
      });
      if (!res.ok) {
        throw new Error(`GitHub issue search failed: ${res.status}`);
      }
      const data = (await res.json()) as { items: GitHubIssueRef[] };
      return data.items;
    },
    async createIssue(title, body, labels) {
      const res = await fetchImpl(`https://api.github.com/repos/${FAILURE_ISSUE_REPO}/issues`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, labels }),
      });
      if (!res.ok) {
        throw new Error(`GitHub issue create failed: ${res.status}`);
      }
      return (await res.json()) as GitHubIssueRef;
    },
    async commentOnIssue(number, body) {
      const res = await fetchImpl(
        `https://api.github.com/repos/${FAILURE_ISSUE_REPO}/issues/${number}/comments`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        }
      );
      if (!res.ok) {
        throw new Error(`GitHub issue comment failed: ${res.status}`);
      }
    },
    async closeIssue(number) {
      const res = await fetchImpl(`https://api.github.com/repos/${FAILURE_ISSUE_REPO}/issues/${number}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      });
      if (!res.ok) {
        throw new Error(`GitHub issue close failed: ${res.status}`);
      }
    },
  };
}

/**
 * Wraps a task's full run with GitHub-issue-on-failure/recovery: on success,
 * best-effort-closes any open failure issue for `sourceId`; on failure,
 * best-effort-files/comments on one, then RE-THROWS the original error so
 * Trigger.dev's own run history still shows the failure (Solution: "Failures
 * surface both through Trigger.dev's own run history ... and as a GitHub
 * issue" — neither replaces the other). The GitHub-issue side effect is
 * always best-effort: a GitHub API hiccup while reporting must never mask
 * the task's real outcome (a working run reported as failed, or a failing
 * run silently swallowed because the issue-filing call itself errored).
 */
export async function withVendorDocsFailureReporting<T>(
  sourceId: VendorDocsSourceId,
  ghPat: string,
  runId: string | null,
  fn: () => Promise<T>,
  /** Injectable for tests; defaults to the real GitHub REST client. */
  client: GitHubIssueClient = createGitHubIssueClient(ghPat)
): Promise<T> {
  try {
    const result = await fn();
    await reportVendorDocsRecovery(sourceId, runId, client).catch(() => {});
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reportVendorDocsFailure(sourceId, message, runId, client).catch(() => {});
    throw error;
  }
}
