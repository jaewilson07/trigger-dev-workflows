/**
 * Weekly model-drift watchdog — the self-hosted models on cubby vs. what the
 * HuggingFace Hub now says exists.
 *
 * Extends the dependency-drift seam (`infra-health.ts`'s `latestFromSource`,
 * `hf:` kind added there) rather than standing up a parallel system: the WHAT
 * lives in `../config/model-watch.json`, the decisions in this file (pure), the
 * scheduled entry point in `../trigger/modelDriftReport.ts`.
 *
 * ## State is GitHub, not a file
 *
 * Every filed issue carries hidden markers:
 *
 *   `<!-- model-drift:<repo>@<sha> -->`   one per upstream revision
 *   `<!-- model-drift-family:<repo> -->`  one per newly seen family repo
 *   `<!-- model-drift-files:<json> -->`   file list at filing time, so the next
 *                                         issue for that repo can say which
 *                                         files are NEW rather than just "changed"
 *
 * The dedupe search deliberately spans open AND closed issues: closing an
 * issue means "seen, decided", and re-filing the same revision every week
 * would train the reader to ignore the label. A crash mid-run just repeats
 * the same searches next time, so the job is resumable and idempotent by
 * construction (same shape as `failureAlertReporter.ts`).
 *
 * No `@datacrew/trigger-shared` import: keeps this file on relative-only
 * imports so it runs under watchdog's plain `tsc`-then-`node --test` harness.
 */

const HF_API = "https://huggingface.co/api/models";
const GITHUB_API = "https://api.github.com";

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

export type WatchedRepo = {
  repo: string;
  role: string;
  /** Commit sha we run. When set, "changed" means upstream sha differs. */
  pinnedRevision?: string;
};

export type FamilyWatch = {
  author: string;
  search: string;
  /** Regex a repo id must match to count as a new family member. */
  pattern: string;
  flags?: string;
};

export type WatchedModel = {
  id: string;
  name: string;
  deployedIn: string;
  pinnedFiles: string[];
  repos: WatchedRepo[];
  families: FamilyWatch[];
};

export type ModelWatchManifest = {
  issueRepo: string;
  fallbackIssueRepo: string;
  issueLabels: string[];
  /** ISO date; anything created/modified after it and not pinned is "new". */
  watchSince: string;
  maxNewFamilyIssuesPerRun: number;
  filePattern: string;
  models: WatchedModel[];
};

// ---------------------------------------------------------------------------
// HuggingFace
// ---------------------------------------------------------------------------

export type HfModelInfo = {
  id: string;
  sha: string;
  lastModified: string;
  createdAt?: string;
  files: string[];
};

export type HfFamilyHit = { id: string; createdAt: string };

export type HfClient = {
  model(repo: string): Promise<HfModelInfo>;
  search(author: string, search: string): Promise<HfFamilyHit[]>;
};

export function createHfClient(fetchImpl: typeof fetch = fetch, token?: string): HfClient {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function getJson(url: string): Promise<unknown> {
    // fetch follows the 307 HF answers with for a renamed repo.
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HuggingFace ${url} -> ${res.status}`);
    return res.json();
  }

  return {
    async model(repo) {
      const d = (await getJson(`${HF_API}/${repo}`)) as {
        id?: string;
        sha?: string;
        lastModified?: string;
        createdAt?: string;
        siblings?: Array<{ rfilename: string }>;
      };
      if (!d.sha || !d.lastModified) throw new Error(`HuggingFace ${repo}: response had no sha/lastModified`);
      return {
        id: d.id ?? repo,
        sha: d.sha,
        lastModified: d.lastModified,
        createdAt: d.createdAt,
        files: (d.siblings ?? []).map((s) => s.rfilename),
      };
    },
    async search(author, search) {
      const q = new URLSearchParams({ author, search, sort: "createdAt", direction: "-1", limit: "100" });
      const d = (await getJson(`${HF_API}?${q}`)) as Array<{ id: string; createdAt?: string }>;
      return d.filter((m) => m.createdAt).map((m) => ({ id: m.id, createdAt: m.createdAt as string }));
    },
  };
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

export type RepoAssessment = {
  changed: boolean;
  reason: string;
};

/** Pinned repos compare by sha; unpinned ones by lastModified vs `watchSince`. */
export function assessRepo(watched: WatchedRepo, info: HfModelInfo, watchSince: string): RepoAssessment {
  if (watched.pinnedRevision) {
    return watched.pinnedRevision === info.sha
      ? { changed: false, reason: "upstream sha equals the pinned revision" }
      : { changed: true, reason: `upstream sha ${short(info.sha)} differs from pinned ${short(watched.pinnedRevision)}` };
  }
  return Date.parse(info.lastModified) > Date.parse(watchSince)
    ? { changed: true, reason: `modified ${info.lastModified}, after watch baseline ${watchSince}` }
    : { changed: false, reason: "not modified since the watch baseline" };
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}

export function matchesFamily(family: FamilyWatch, id: string): boolean {
  return new RegExp(family.pattern, family.flags ?? "").test(id);
}

/** Repos in a family search that are new, matching, and not already watched. */
export function newFamilyRepos(
  family: FamilyWatch,
  hits: HfFamilyHit[],
  alreadyWatched: Set<string>,
  watchSince: string
): HfFamilyHit[] {
  const since = Date.parse(watchSince);
  return hits.filter(
    (h) =>
      Date.parse(h.createdAt) > since &&
      !alreadyWatched.has(h.id.toLowerCase()) &&
      matchesFamily(family, h.id)
  );
}

export function interestingFiles(files: string[], filePattern: string): string[] {
  const re = new RegExp(filePattern, "i");
  return files.filter((f) => re.test(f));
}

/** Files present now that the previous snapshot did not have. `null` = no snapshot. */
export function diffFiles(previous: string[] | null, current: string[]): string[] | null {
  if (!previous) return null;
  const had = new Set(previous);
  return current.filter((f) => !had.has(f));
}

// ---------------------------------------------------------------------------
// Markers and issue bodies
// ---------------------------------------------------------------------------

export const revisionMarker = (repo: string, sha: string) => `model-drift:${repo}@${sha}`;
export const familyMarker = (repo: string) => `model-drift-family:${repo}`;
/** Searched to find the previous snapshot of a repo (any revision). */
export const repoSearchMarker = (repo: string) => `model-drift:${repo}@`;

export function filesMarker(files: string[]): string {
  // `--` is illegal inside an HTML comment; file names never need it.
  return `<!-- model-drift-files:${JSON.stringify(files).replace(/--/g, "-\\u002d")} -->`;
}

export function parseFilesMarker(body: string): string[] | null {
  const m = body.match(/<!-- model-drift-files:(.*?) -->/s);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

const PROBE_NOTE =
  "**Probe before deploy.** Do not swap this into a GPU_CRITICAL service directly. " +
  "Load it on GPU_BESTEFFORT first (quant, VRAM fit, tool-call/vision/embedding-dim behavior, latency), " +
  "then deploy. Bump `pinnedRevision` in `watchdog/src/config/model-watch.json` in trigger-dev-workflows once an upgrade lands.";

export type RevisionIssue = { title: string; body: string; marker: string };

export function buildRevisionIssue(args: {
  model: WatchedModel;
  watched: WatchedRepo;
  info: HfModelInfo;
  assessment: RepoAssessment;
  newFiles: string[] | null;
  interesting: string[];
  fallbackNote?: string;
}): RevisionIssue {
  const { model, watched, info, assessment, newFiles, interesting } = args;
  const marker = revisionMarker(watched.repo, info.sha);
  const pinned = watched.pinnedRevision
    ? `\`${watched.pinnedRevision}\``
    : model.pinnedFiles.length
      ? "no revision pinned (weights downloaded by file name)"
      : "no revision pinned (downloaded by repo name)";
  const lines = [
    `**Model:** ${model.name} (\`${model.id}\`)`,
    `**Watched repo:** [${watched.repo}](https://huggingface.co/${watched.repo}) - ${watched.role}`,
    `**Deployed in:** ${model.deployedIn}`,
    `**Current pinned revision:** ${pinned}`,
    `**Current pinned files:** ${model.pinnedFiles.length ? model.pinnedFiles.map((f) => `\`${f}\``).join(", ") : "n/a"}`,
    "",
    "### What is new",
    `- Upstream revision: \`${info.sha}\` (${assessment.reason})`,
    `- Last modified: ${info.lastModified}`,
  ];
  if (newFiles === null) {
    lines.push(`- No earlier snapshot to diff against; ${interesting.length} weight file(s) currently in the repo.`);
  } else if (newFiles.length) {
    lines.push(`- New files since the last snapshot (${newFiles.length}):`, ...newFiles.slice(0, 40).map((f) => `  - \`${f}\``));
  } else {
    lines.push("- No new files since the last snapshot (existing files were edited).");
  }
  lines.push(
    `- Link: https://huggingface.co/${watched.repo}/commits/main`,
    "",
    PROBE_NOTE,
    "",
    `<!-- ${marker} -->`,
    filesMarker(info.files)
  );
  if (args.fallbackNote) lines.push("", args.fallbackNote);
  return {
    title: `model-drift: ${model.name}: ${watched.repo} changed upstream (${short(info.sha)})`,
    body: lines.join("\n"),
    marker,
  };
}

export function buildFamilyIssue(args: {
  model: WatchedModel;
  family: FamilyWatch;
  hit: HfFamilyHit;
  fallbackNote?: string;
}): { title: string; body: string; marker: string } {
  const { model, family, hit } = args;
  const marker = familyMarker(hit.id);
  const lines = [
    `**Model:** ${model.name} (\`${model.id}\`)`,
    `**Deployed in:** ${model.deployedIn}`,
    `**Current pinned files:** ${model.pinnedFiles.length ? model.pinnedFiles.map((f) => `\`${f}\``).join(", ") : "n/a"}`,
    "",
    "### What is new",
    `- New family repo: [${hit.id}](https://huggingface.co/${hit.id}), created ${hit.createdAt}`,
    `- Found by searching author \`${family.author}\` for \`${family.search}\` (matched \`${family.pattern}\`).`,
    `- Link: https://huggingface.co/${hit.id}`,
    "",
    PROBE_NOTE,
    "",
    `<!-- ${marker} -->`,
  ];
  if (args.fallbackNote) lines.push("", args.fallbackNote);
  return {
    title: `model-drift: ${model.name}: new family repo ${hit.id}`,
    body: lines.join("\n"),
    marker,
  };
}

// ---------------------------------------------------------------------------
// GitHub issue client
// ---------------------------------------------------------------------------

export type IssueRef = { number: number; html_url: string; body?: string };

export class GitHubAccessError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubAccessError";
    this.status = status;
  }
}

export type IssueClient = {
  repo: string;
  /** Throws GitHubAccessError when the token cannot see/write the repo. */
  probe(): Promise<void>;
  /** Open OR closed issue containing the hidden marker text. */
  findByMarker(marker: string): Promise<IssueRef | null>;
  /** Newest issue whose marker starts with `prefix` (for the previous snapshot). */
  findLatestByMarkerPrefix(prefix: string): Promise<IssueRef | null>;
  createIssue(title: string, body: string, labels: string[]): Promise<IssueRef>;
};

export function createIssueClient(ghToken: string, repo: string, fetchImpl: typeof fetch = fetch): IssueClient {
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "trigger-dev-workflows-model-drift",
  };

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetchImpl(`${GITHUB_API}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });
    if (res.status === 403 || res.status === 404) {
      throw new GitHubAccessError(`GitHub API ${path} -> ${res.status}`, res.status);
    }
    return res;
  }

  async function search(marker: string): Promise<IssueRef[]> {
    const q = `repo:${repo} type:issue in:body "${marker}"`;
    const res = await request(`/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=10`);
    if (!res.ok) throw new Error(`GitHub issue search failed: ${res.status}`);
    return ((await res.json()) as { items: IssueRef[] }).items;
  }

  return {
    repo,
    async probe() {
      const res = await request(`/repos/${repo}`);
      if (!res.ok) throw new Error(`GitHub repo probe failed: ${res.status}`);
    },
    async findByMarker(marker) {
      // The search tokenizer is fuzzy; keep only true substring hits.
      return (await search(marker)).find((i) => i.body?.includes(`<!-- ${marker} -->`)) ?? null;
    },
    async findLatestByMarkerPrefix(prefix) {
      return (await search(prefix.replace(/@$/, ""))).find((i) => i.body?.includes(`<!-- ${prefix}`)) ?? null;
    },
    async createIssue(title, body, labels) {
      const attempt = (withLabels: boolean) =>
        request(`/repos/${repo}/issues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withLabels ? { title, body, labels } : { title, body }),
        });
      let res = await attempt(true);
      // A label problem must not lose the issue.
      if (!res.ok && res.status === 422) res = await attempt(false);
      if (!res.ok) throw new Error(`GitHub issue create failed: ${res.status}`);
      return (await res.json()) as IssueRef;
    },
  };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export type SweepFinding = {
  kind: "revision" | "family";
  modelId: string;
  repo: string;
  action: "filed" | "would-file" | "deduped";
  title: string;
  issueUrl?: string;
  body?: string;
};

export type SweepResult = {
  issueRepo: string;
  findings: SweepFinding[];
  errors: string[];
  /** Repos checked, for the "silence is meaningful" log line. */
  checked: number;
};

export async function runModelDriftSweep(deps: {
  manifest: ModelWatchManifest;
  hf: HfClient;
  primary: IssueClient;
  fallback?: IssueClient;
  /** Report what would be filed; never create. Dedupe searches still run. */
  dryRun?: boolean;
  /** Override the manifest baseline (dry runs, backfills). */
  watchSince?: string;
}): Promise<SweepResult> {
  const { manifest, hf, dryRun } = deps;
  const watchSince = deps.watchSince ?? manifest.watchSince;
  const findings: SweepFinding[] = [];
  const errors: string[] = [];
  let checked = 0;

  let issues = deps.primary;
  let fallbackNote: string | undefined;
  try {
    await issues.probe();
  } catch (err) {
    if (err instanceof GitHubAccessError && deps.fallback) {
      fallbackNote = `_Filed here because the token could not reach \`${deps.primary.repo}\` (${err.message}); move it there._`;
      issues = deps.fallback;
    } else {
      throw err;
    }
  }

  const file = async (kind: SweepFinding["kind"], modelId: string, repo: string, issue: { title: string; body: string; marker: string }) => {
    if (await issues.findByMarker(issue.marker)) {
      findings.push({ kind, modelId, repo, action: "deduped", title: issue.title });
      return;
    }
    if (dryRun) {
      findings.push({ kind, modelId, repo, action: "would-file", title: issue.title, body: issue.body });
      return;
    }
    const created = await issues.createIssue(issue.title, issue.body, manifest.issueLabels);
    findings.push({ kind, modelId, repo, action: "filed", title: issue.title, issueUrl: created.html_url });
  };

  const watchedIds = new Set(
    manifest.models.flatMap((m) => m.repos.map((r) => r.repo.toLowerCase()))
  );
  let familyBudget = manifest.maxNewFamilyIssuesPerRun;

  for (const model of manifest.models) {
    for (const watched of model.repos) {
      checked++;
      try {
        const info = await hf.model(watched.repo);
        const assessment = assessRepo(watched, info, watchSince);
        if (!assessment.changed) continue;
        const interesting = interestingFiles(info.files, manifest.filePattern);
        const marker = revisionMarker(watched.repo, info.sha);
        let newFiles: string[] | null = null;
        // Only pay for the previous-snapshot lookup when we are about to file.
        if (!(await issues.findByMarker(marker))) {
          const prev = await issues.findLatestByMarkerPrefix(repoSearchMarker(watched.repo));
          newFiles = diffFiles(prev?.body ? parseFilesMarker(prev.body) : null, info.files);
        }
        await file(
          "revision",
          model.id,
          watched.repo,
          buildRevisionIssue({ model, watched, info, assessment, newFiles, interesting, fallbackNote })
        );
      } catch (err) {
        if (err instanceof GitHubAccessError) throw err;
        errors.push(`${model.id}/${watched.repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const family of model.families) {
      try {
        const hits = newFamilyRepos(family, await hf.search(family.author, family.search), watchedIds, watchSince);
        for (const hit of hits) {
          if (familyBudget <= 0) break;
          const before = findings.length;
          await file("family", model.id, hit.id, buildFamilyIssue({ model, family, hit, fallbackNote }));
          // Only new filings spend budget; deduped repeats are free.
          if (findings[before]?.action !== "deduped") familyBudget--;
        }
      } catch (err) {
        if (err instanceof GitHubAccessError) throw err;
        errors.push(`${model.id}/family ${family.author}:${family.search}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { issueRepo: issues.repo, findings, errors, checked };
}
