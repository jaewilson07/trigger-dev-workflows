/**
 * Shared types and helpers for GitHub repo monitoring.
 *
 * Used by the repo-monitor schedule to check upstream repos (Paperclip, Letta,
 * and potentially others) for new releases and notable commits.
 *
 * Pattern mirrors `infra-health.ts`: pure types + side-effect-free helpers +
 * thin I/O wrappers, no knowledge of any delivery destination.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RepoRelease = {
  tag: string;
  publishedAt: string;
  name: string;
  body: string;
  htmlUrl: string;
};

export type RepoCommit = {
  sha: string;
  date: string;
  message: string;
  author: string;
  htmlUrl: string;
};

export type RepoMonitorResult = {
  repo: string;
  latestRelease: RepoRelease | null;
  recentCommits: RepoCommit[];
  /** Whether there is a new release since `lastKnownTag`. */
  hasNewRelease: boolean;
  /** Commits since `lastKnownSha`, or all returned if no cache. */
  newCommits: RepoCommit[];
};

export type RepoMonitorReport = {
  date: string;
  generatedAt: string;
  results: RepoMonitorResult[];
  /** True if any repo has a new release or notable new commits. */
  hasUpdates: boolean;
};

export type RepoTarget = {
  /** GitHub owner/repo, e.g. "paperclipai/paperclip" */
  repo: string;
  /** Last known release tag (cache). */
  lastKnownTag: string | null;
  /** Last known commit SHA (cache). */
  lastKnownSha: string | null;
  /** Labels to filter notable issues by (empty = skip issues). */
  issueLabels?: string[];
};

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "datacrew-trigger-repo-monitor/1.0",
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub API fetch failed for ${url}: ${res.status}`);
  }
  return res.json();
}

export async function fetchLatestReleases(repo: string, perPage = 3): Promise<RepoRelease[]> {
  const payload = (await fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=${perPage}`
  )) as Array<{
    tag_name?: string;
    published_at?: string;
    name?: string;
    body?: string;
    html_url?: string;
  }>;

  return payload.map((r) => ({
    tag: r.tag_name ?? "",
    publishedAt: r.published_at ?? "",
    name: r.name ?? "",
    body: r.body ?? "",
    htmlUrl: r.html_url ?? "",
  }));
}

export async function fetchRecentCommits(repo: string, perPage = 10): Promise<RepoCommit[]> {
  const payload = (await fetchJson(
    `https://api.github.com/repos/${repo}/commits?per_page=${perPage}`
  )) as Array<{
    sha?: string;
    commit?: {
      committer?: { date?: string; name?: string };
      message?: string;
    };
    html_url?: string;
  }>;

  return payload.map((c) => ({
    sha: c.sha ?? "",
    date: c.commit?.committer?.date ?? "",
    message: (c.commit?.message ?? "").split("\n")[0], // first line only
    author: c.commit?.committer?.name ?? "",
    htmlUrl: c.html_url ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Rendering — called by the delivery half only
// ---------------------------------------------------------------------------

/**
 * Keywords that make a commit "notable" for our setup.
 * We care about: agent adapters, heartbeat/scheduler, secrets, API changes,
 * Docker/deployment, skills, and breaking changes.
 */
const NOTABLE_KEYWORDS = [
  "adapter",
  "heartbeat",
  "scheduler",
  "secret",
  "api",
  "docker",
  "deploy",
  "skill",
  "breaking",
  "migration",
  "agent",
  "trigger",
  "review",
  "config",
];

export function isNotableCommit(commit: RepoCommit): boolean {
  const msg = commit.message.toLowerCase();
  return NOTABLE_KEYWORDS.some((kw) => msg.includes(kw));
}

export function buildSlackText(report: RepoMonitorReport): string {
  if (!report.hasUpdates) {
    return "Repo monitor — no new releases or notable commits.";
  }

  const sections = report.results.map((r) => {
    const lines: string[] = [`*${r.repo}*`];

    if (r.hasNewRelease && r.latestRelease) {
      lines.push(`  New release: ${r.latestRelease.tag} (${r.latestRelease.publishedAt.slice(0, 10)})`);
      lines.push(`  ${r.latestRelease.htmlUrl}`);
    }

    if (r.newCommits.length > 0) {
      lines.push(`  Notable commits (${r.newCommits.length}):`);
      for (const c of r.newCommits.slice(0, 5)) {
        lines.push(`  • ${c.sha.slice(0, 8)} ${c.message.slice(0, 100)}`);
      }
    }

    return lines.join("\n");
  });

  return ["Repo monitor report", "", ...sections].join("\n");
}

export function buildSlackBlocks(report: RepoMonitorReport): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Repo monitor report", emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: report.hasUpdates
            ? `:rocket: Updates found · ${report.date}`
            : `:white_check_mark: All up to date · ${report.date}`,
        },
      ],
    },
  ];

  for (const r of report.results) {
    const sectionLines: string[] = [`*${r.repo}*`];

    if (r.hasNewRelease && r.latestRelease) {
      sectionLines.push(
        `:package: New release: *${r.latestRelease.tag}* (${r.latestRelease.publishedAt.slice(0, 10)})`
      );
      sectionLines.push(`<${r.latestRelease.htmlUrl}|Release notes>`);
    }

    if (r.newCommits.length > 0) {
      sectionLines.push(`:git: Notable commits (${r.newCommits.length}):`);
      for (const c of r.newCommits.slice(0, 5)) {
        sectionLines.push(`  • \`${c.sha.slice(0, 8)}\` ${c.message.slice(0, 100)}`);
      }
    }

    if (!r.hasNewRelease && r.newCommits.length === 0) {
      sectionLines.push("  _No changes since last check._");
    }

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: sectionLines.join("\n") },
    });
  }

  return blocks;
}
