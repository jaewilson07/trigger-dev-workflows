/**
 * IO shell for the failure-alert watchdog task
 * (jaewilson07/trigger-dev-workflows#206). Files/comments-on GitHub issues
 * for tasks `failureAlertCore.ts` decides warrant one. Everything
 * decision-y lives in that pure module; this file is GitHub API calls and
 * sweep wiring.
 *
 * Deliberately has NO import of `@datacrew/trigger-shared` (see
 * `failureAlertFetch.ts`'s doc comment for why) — `fetchRuns` is a required
 * dependency of `runFailureAlertSweep`, supplied by the real
 * `fetchRunsForProject` only at the trigger-task call site
 * (`../trigger/failureAlertReport.ts`), so this file and its tests stay on
 * relative-only imports and run under watchdog's plain `tsc`-then-`node
 * --test` harness.
 */

import {
  assessTaskRuns,
  buildFailureComment,
  buildFailureIssue,
  buildFallbackNote,
  groupRunsByTask,
  shouldThrottleComment,
  type RawRun,
  type TaskAssessment,
} from "./failureAlertCore.js";
import { DEFAULT_OWNING_REPO, getOwningRepo, MONITORED_PROJECTS } from "./failureRepoMap.js";

const GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * Raised when a GitHub API call returns 403/404 — the signal to fall back
 * to `DEFAULT_OWNING_REPO` (#206: "if the target repo returns 403/404 ...
 * fall back to filing in jaewilson07/trigger-dev-workflows").
 */
export class GitHubAccessError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubAccessError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// GitHub issue client
// ---------------------------------------------------------------------------

export type GitHubIssueRef = { number: number; html_url: string };

export type GitHubIssueClient = {
  /** Search OPEN issues in this client's repo for the hidden fingerprint marker. */
  findByFingerprint(fingerprint: string): Promise<GitHubIssueRef | null>;
  createIssue(title: string, body: string, labels: string[]): Promise<GitHubIssueRef>;
  commentOnIssue(issueNumber: number, body: string): Promise<void>;
  /** `null` when the issue has no comments yet. */
  getLastCommentAt(issueNumber: number): Promise<Date | null>;
};

/**
 * `repo` is fixed per client instance (unlike `vendorDocsIngest.ts`'s
 * `createGitHubIssueClient`, which hardcodes its own single
 * `FAILURE_ISSUE_REPO`) — this one is built fresh per intended-owner repo,
 * and again against the fallback repo when the first attempt 403/404s.
 */
export function createGitHubIssueClient(
  ghToken: string,
  repo: string,
  fetchImpl: typeof fetch = fetch
): GitHubIssueClient {
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "trigger-dev-workflows-failure-alert",
  };

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetchImpl(`${GITHUB_API_BASE_URL}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });
    if (res.status === 403 || res.status === 404) {
      throw new GitHubAccessError(`GitHub API ${path} -> ${res.status}`, res.status);
    }
    return res;
  }

  return {
    async findByFingerprint(fingerprint) {
      const q = `repo:${repo} type:issue state:open in:body "trigger-failure:${fingerprint}"`;
      const res = await request(`/search/issues?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        throw new Error(`GitHub issue search failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as { items: GitHubIssueRef[] };
      return data.items[0] ?? null;
    },

    async createIssue(title, body, labels) {
      const attempt = async (withLabels: boolean): Promise<Response> =>
        request(`/repos/${repo}/issues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withLabels ? { title, body, labels } : { title, body }),
        });

      let res = await attempt(true);
      if (!res.ok && res.status === 422) {
        // Best-effort per #206: a label problem (e.g. an org that disabled
        // auto-creating labels) must not fail the whole run — retry with no
        // labels rather than lose the issue entirely.
        res = await attempt(false);
      }
      if (!res.ok) {
        throw new Error(`GitHub issue create failed: ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as GitHubIssueRef;
    },

    async commentOnIssue(issueNumber, body) {
      const res = await request(`/repos/${repo}/issues/${issueNumber}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        throw new Error(`GitHub issue comment failed: ${res.status} ${await res.text()}`);
      }
    },

    async getLastCommentAt(issueNumber) {
      const res = await request(
        `/repos/${repo}/issues/${issueNumber}/comments?per_page=1&sort=created&direction=desc`
      );
      if (!res.ok) {
        throw new Error(`GitHub issue comments list failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as Array<{ created_at: string }>;
      return data[0] ? new Date(data[0].created_at) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type FiledAction = "created" | "commented" | "throttled";

export type FiledResult = {
  project: string;
  taskId: string;
  action: FiledAction;
  repo: string;
  issueNumber: number;
};

export type SweepResult = {
  filed: FiledResult[];
  /** `"project/task: message"` — a fetch or GitHub-API failure for one
   * task/project never aborts the rest of the sweep (best-effort, matches
   * `withVendorDocsFailureReporting`'s "never mask other outcomes" rule). */
  errors: string[];
};

type ClientFactory = (ghToken: string, repo: string) => GitHubIssueClient;

async function reportOneFailure(
  projectKey: string,
  taskId: string,
  assessment: TaskAssessment,
  ghToken: string,
  makeClient: ClientFactory
): Promise<FiledResult> {
  const intendedRepo = getOwningRepo(projectKey, taskId);

  async function fileAgainst(repo: string, fallbackFrom: string | null): Promise<FiledResult> {
    const client = makeClient(ghToken, repo);
    const issue = buildFailureIssue({ project: projectKey, taskId, assessment });

    const existing = await client.findByFingerprint(issue.fingerprint);
    if (existing) {
      const lastCommentAt = await client.getLastCommentAt(existing.number);
      if (shouldThrottleComment(lastCommentAt)) {
        return { project: projectKey, taskId, action: "throttled", repo, issueNumber: existing.number };
      }
      const comment = buildFailureComment({ project: projectKey, taskId, assessment });
      await client.commentOnIssue(existing.number, comment);
      return { project: projectKey, taskId, action: "commented", repo, issueNumber: existing.number };
    }

    const body = fallbackFrom ? buildFallbackNote(fallbackFrom) + issue.body : issue.body;
    const created = await client.createIssue(issue.title, body, issue.labels);
    return { project: projectKey, taskId, action: "created", repo, issueNumber: created.number };
  }

  try {
    return await fileAgainst(intendedRepo, null);
  } catch (err) {
    if (err instanceof GitHubAccessError && intendedRepo !== DEFAULT_OWNING_REPO) {
      return await fileAgainst(DEFAULT_OWNING_REPO, intendedRepo);
    }
    throw err;
  }
}

export type SweepDeps = {
  /** No default — the real implementation (`fetchRunsForProject`,
   * `../lib/failureAlertFetch.ts`) needs `@datacrew/trigger-shared`, which
   * this file deliberately does not import (see the file-level comment). */
  fetchRuns: (projectKey: string, windowStart: Date) => Promise<RawRun[]>;
  resolveGhToken: () => Promise<string>;
  makeClient?: ClientFactory;
  now?: Date;
  /** How far back to look for runs. 7 days matches `trigger-deadman.mjs`'s
   * own freshness window default. */
  windowDays?: number;
};

/** One sweep across all `MONITORED_PROJECTS`. Never throws for a single
 * project/task's failure — collects it in `errors` and keeps going. */
export async function runFailureAlertSweep(deps: SweepDeps): Promise<SweepResult> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - (deps.windowDays ?? 7) * 24 * 3_600_000);
  const { fetchRuns } = deps;
  const makeClient = deps.makeClient ?? ((token: string, repo: string) => createGitHubIssueClient(token, repo));

  const filed: FiledResult[] = [];
  const errors: string[] = [];

  let ghToken: string;
  try {
    ghToken = await deps.resolveGhToken();
  } catch (err) {
    return { filed, errors: [`resolveGhToken: ${err instanceof Error ? err.message : String(err)}`] };
  }

  for (const { key: projectKey } of MONITORED_PROJECTS) {
    let runs: RawRun[];
    try {
      runs = await fetchRuns(projectKey, windowStart);
    } catch (err) {
      errors.push(`${projectKey}: failed to fetch runs — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const byTask = groupRunsByTask(runs);
    for (const [taskId, taskRuns] of byTask) {
      const assessment = assessTaskRuns(taskId, taskRuns);
      if (!assessment.shouldFile) continue;

      try {
        filed.push(await reportOneFailure(projectKey, taskId, assessment, ghToken, makeClient));
      } catch (err) {
        errors.push(`${projectKey}/${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { filed, errors };
}
