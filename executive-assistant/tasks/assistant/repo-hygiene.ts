import { schedules, logger } from "@trigger.dev/sdk";
import { getSecret, cloneRepo, runUv } from "@datacrew/trigger-shared";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Nightly repo hygiene sweep per ADR-054 (trigger.dev as orchestration layer).
 *
 * This task OBSERVES, TRIAGES, and REPORTS. It NEVER deletes anything.
 *
 * Three-step pipeline:
 *   1. Detection sweep — read-only scan of ~/GitHub/ repos for:
 *      - dirty working trees
 *      - unmerged branches (vs main/master)
 *      - stashes
 *      - stale worktrees
 *   2. Rizz triage — LLM-powered verdict per branch:
 *      - RESUME: clear intent, active work → file `ready-for-human` issue with reconstructed intent
 *      - GHOST: commits but no clear intent, stale → Slack digest line with reply-to-delete command
 *      - STALE: no commits or very old → Slack digest line (no issue)
 *   3. Slack digest — post summary to configured channel, one line per GHOST/STALE verdict
 *
 * HARD GUARDRAIL: This workflow NEVER deletes branches, stashes, or worktrees.
 * Deletion only happens on Jae's explicit trigger (reply-to-delete in Slack).
 *
 * Dedup: The detection step deduplicates findings by (repo, branch) key.
 * If the same branch appears in multiple clones (e.g., homeserver vs infra-bonker),
 * it's reported once with both clone paths noted.
 */

interface RepoFinding {
  repo: string;
  clonePath: string;
  branch: string;
  commitsAhead: number;
  lastCommitDate: string;
  lastCommitMessage: string;
  isDirty: boolean;
  hasStash: boolean;
  worktreePath?: string;
}

interface TriageVerdict {
  finding: RepoFinding;
  verdict: "RESUME" | "GHOST" | "STALE";
  reasoning: string;
  suggestedIntent?: string; // for RESUME verdicts
}

const REPOS_TO_SCAN = [
  "datacrew",
  "mdrag",
  "simpleDiscordBot",
  "trigger-dev-workflows",
  "homeserver", // infra-bonker clone
  "datacrew-private-memories",
];

export const repoHygiene = schedules.task({
  id: "repo-hygiene-nightly",
  cron: {
    pattern: "0 3 * * *", // 3 AM UTC (9 PM MDT)
    timezone: "UTC",
  },
  ttl: "15m",
  queue: {
    concurrencyLimit: 1,
  },
  retry: { maxAttempts: 2 },
  run: async () => {
    logger.info("starting repo-hygiene detection sweep");

    const githubPat = await getSecret("JAEWILSON07_GH_PAT");
    const slackToken = await getSecret("DATACREW_SLACK_BOT_TOKEN");
    const slackChannel = process.env.REPO_HYGIENE_SLACK_CHANNEL ?? "C0C49TXMD19";

    const findings: RepoFinding[] = [];
    const baseDir = path.join(os.homedir(), "GitHub");

    // --- Detection sweep (read-only) ---
    for (const repo of REPOS_TO_SCAN) {
      const repoPath = path.join(baseDir, repo);
      try {
        const repoFindings = await scanRepo(repoPath, repo);
        findings.push(...repoFindings);
      } catch (err) {
        logger.error(`failed to scan ${repo}`, { error: String(err) });
      }
    }

    logger.info("detection sweep complete", { findingCount: findings.length });

    // --- Dedup by (repo, branch) ---
    const deduped = deduplicateFindings(findings);

    // --- Rizz triage ---
    const verdicts = await runRizzTriage(deduped, githubPat);

    // --- Separate verdicts ---
    const resume = verdicts.filter((v) => v.verdict === "RESUME");
    const ghosts = verdicts.filter((v) => v.verdict === "GHOST");
    const stale = verdicts.filter((v) => v.verdict === "STALE");

    logger.info("triage complete", {
      resume: resume.length,
      ghost: ghosts.length,
      stale: stale.length,
    });

    // --- File ready-for-human issues for RESUME verdicts ---
    for (const v of resume) {
      await fileReadyForHumanIssue(v, githubPat);
    }

    // --- Post Slack digest for GHOST/STALE ---
    if (ghosts.length > 0 || stale.length > 0) {
      await postSlackDigest(ghosts, stale, slackToken, slackChannel);
    }

    return {
      scannedRepos: REPOS_TO_SCAN.length,
      totalFindings: findings.length,
      dedupedFindings: deduped.length,
      resumeCount: resume.length,
      ghostCount: ghosts.length,
      staleCount: stale.length,
    };
  },
});

// --- Detection helpers ---

async function scanRepo(repoPath: string, repoName: string): Promise<RepoFinding[]> {
  const findings: RepoFinding[] = [];
  const stat = await fs.stat(repoPath).catch(() => null);
  if (!stat?.isDirectory()) return findings;

  // Check if it's a git repo
  const gitDir = path.join(repoPath, ".git");
  const isGit = await fs.stat(gitDir).catch(() => null);
  if (!isGit) return findings;

  // Use git commands to gather info
  // This is a simplified implementation — the full version would shell out to git
  // For now, return empty (implementation requires git CLI in container)
  logger.info(`scanned ${repoName}`, { path: repoPath });

  return findings;
}

function deduplicateFindings(findings: RepoFinding[]): RepoFinding[] {
  const seen = new Map<string, RepoFinding>();
  for (const f of findings) {
    const key = `${f.repo}::${f.branch}`;
    const existing = seen.get(key);
    if (existing) {
      // Merge clone paths
      if (existing.clonePath !== f.clonePath) {
        existing.clonePath = `${existing.clonePath}, ${f.clonePath}`;
      }
    } else {
      seen.set(key, f);
    }
  }
  return Array.from(seen.values());
}

// --- Rizz triage ---
// This step is IdrisBot's lane — the prompt template and verdict criteria
// should be reviewed by him before deployment.

async function runRizzTriage(
  findings: RepoFinding[],
  _githubPat: string
): Promise<TriageVerdict[]> {
  // TODO: Implement LLM-powered triage per IdrisBot's design.
  // For now, return STALE for everything (safe default).
  return findings.map((f) => ({
    finding: f,
    verdict: "STALE" as const,
    reasoning: "not yet implemented — pending IdrisBot review",
  }));
}

// --- GitHub issue filing ---

async function fileReadyForHumanIssue(
  verdict: TriageVerdict,
  _githubPat: string
): Promise<void> {
  // TODO: Use gh CLI or GitHub API to create issue in the relevant repo.
  logger.info(`would file ready-for-human issue`, {
    repo: verdict.finding.repo,
    branch: verdict.finding.branch,
    suggestedIntent: verdict.suggestedIntent,
  });
}

// --- Slack digest ---

async function postSlackDigest(
  ghosts: TriageVerdict[],
  stale: TriageVerdict[],
  slackToken: string,
  channel: string
): Promise<void> {
  const lines: string[] = [":broom: *Nightly repo hygiene digest*"];
  
  if (ghosts.length > 0) {
    lines.push("\n*Ghost branches* (commits but no clear intent):");
    for (const g of ghosts) {
      lines.push(
        `  • \`${g.finding.repo}/${g.finding.branch}\` — ${g.finding.commitsAhead} commits, last ${g.finding.lastCommitDate}`
      );
      lines.push(`    _Reply \`delete ${g.finding.repo} ${g.finding.branch}\` to remove._`);
    }
  }

  if (stale.length > 0) {
    lines.push("\n*Stale branches* (no commits or very old):");
    for (const s of stale) {
      lines.push(
        `  • \`${s.finding.repo}/${s.finding.branch}\` — last ${s.finding.lastCommitDate}`
      );
      lines.push(`    _Reply \`delete ${s.finding.repo} ${s.finding.branch}\` to remove._`);
    }
  }

  const text = lines.join("\n");

  // Post to Slack
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${slackToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text }),
  });

  logger.info("posted Slack digest", { channel, ghostCount: ghosts.length, staleCount: stale.length });
}
