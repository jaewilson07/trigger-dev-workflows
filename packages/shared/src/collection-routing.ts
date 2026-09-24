/**
 * Which mdrag collection a save targets, based on which project the work is in.
 *
 * mdrag's own caller-identity routing resolves *who's calling* — for one account
 * that's always the same collection, regardless of which repo the work actually
 * touches. This is the other axis: resolve the NEAREST ENCLOSING repo's own
 * `origin` remote (never a local directory name, which can drift on a
 * rename/reclone) and map its repo name to a collection.
 *
 * `libraries/mdrag/contracts/collection-routing-cases.json` is vendored from
 * mdrag, which owns it — the canonical Python implementation lives in
 * `mdrag.core.collection_routing`. `collection-routing.test.ts` drives this
 * module from the vendored copy and checks it against the upstream file
 * byte-for-byte, the same pattern `mdrag-hop.ts`/`trusted-hop-cases.json`
 * already use for the trusted-hop table.
 *
 * Extracted 2026-09-13 — this rule used to be prose and bash restated in four
 * places with no code behind any of them
 * (`.agents/plans/mdrag-shared-api-extraction.md`, Phase 1).
 */

export const DEFAULT_COLLECTION = "datacrew";

/**
 * Add a row whenever a project's work should collect somewhere other than
 * `DEFAULT_COLLECTION`. Keep in sync with mdrag's `COLLECTION_MAP` and
 * `contracts/collection-routing-cases.json`'s `routes` — the shared test
 * table exists exactly so a row added on one side without the other fails
 * loudly instead of drifting silently.
 */
export const COLLECTION_MAP: Record<string, string> = {
  alix_discordbot: "alix", // personal bot, kept separate from professional work
};

const REMOTE_SLUG_RE = /[:/]([^/]+?)(?:\.git)?$/;

/**
 * Pure lookup: a bare repo name (`basename -s .git` of `origin`) -> collection.
 * No I/O — the part every runtime must agree on.
 */
export function collectionForRepoSlug(repoSlug: string): string {
  return COLLECTION_MAP[repoSlug] ?? DEFAULT_COLLECTION;
}

/**
 * Same lookup, from a full `origin` URL (HTTPS or SSH form) instead of a bare
 * slug. An empty/unparseable URL falls through to `DEFAULT_COLLECTION`, same
 * as "no match" for a slug.
 */
export function collectionForRemoteUrl(remoteUrl: string): string {
  const trimmed = (remoteUrl ?? "").trim();
  if (!trimmed) return DEFAULT_COLLECTION;
  const match = REMOTE_SLUG_RE.exec(trimmed);
  // match[1] is typed `string | undefined` under noUncheckedIndexedAccess
  // (executive-assistant's tsconfig), even though the group always captures.
  if (!match?.[1]) return DEFAULT_COLLECTION;
  return collectionForRepoSlug(match[1]);
}

/**
 * Resolve the collection for the nearest enclosing repo at `repoPath`.
 *
 * Shells out to `git remote get-url origin` and delegates to
 * {@link collectionForRemoteUrl}. A repo with no `origin` remote, or no `.git`
 * at all, resolves to `DEFAULT_COLLECTION` rather than throwing — this is a
 * routing HINT, not a hard requirement.
 */
export async function resolveCollectionForRepo(repoPath = "."): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], { cwd: repoPath });
    return collectionForRemoteUrl(stdout.trim());
  } catch {
    return DEFAULT_COLLECTION;
  }
}
