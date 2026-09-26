import { schedules, logger } from "@trigger.dev/sdk";
import { getSecret, gitAndUv } from "@datacrew/trigger-shared";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Nightly repo hygiene sweep per rizz-sweep spec v2.
 *
 * Three-step pipeline:
 *   1. Detection sweep — read-only scan of ~/GitHub/ repos
 *   2. Rizz triage — LLM-powered verdict per finding (or auto-GHOST for merged)
 *   3. Tiered routing — resume → issue (capped at 10), ghost/stale → digest
 *
 * HARD GUARDRAILS:
 *   - Auto-prune ONLY for PR-confirmed-MERGED branches with tip-SHA match
 *   - 7-day grace period before auto-prune
 *   - NEVER delete on human-judgment grounds
 *   - Max 10 resume issues per run
 */

interface BranchFinding {
  repo: string;
  clonePath: string;
  branch: string;
  tipSha: string;
  commitsAhead: number;
  lastCommitDate: string;
  lastCommitMessage: string;
  diffstat: string;
  prStatus?: "OPEN" | "MERGED" | "CLOSED" | "NONE";
  prNumber?: number;
  prHeadSha?: string;
  prMergedAt?: string;
  isFullyMerged: boolean; // git branch --merged origin/main
  age: number; // days since last commit
}

interface RizzVerdict {
  verdict: "resume" | "ghost" | "stale";
  confidence: "high" | "medium" | "low";
  what_this_was: string;
  where_it_stopped: string;
  next_step: string;
  evidence: string;
}

const EXCLUSIONS = [
  "knowledge-base", // symlink facade
  "datacrew-private-memories", // already clean
];

const UPSTREAM_FORK_REPOS = ["trigger.dev"]; // local-customization branches → digest-only

const REPOS_TO_SCAN = [
  "datacrew",
  "mdrag",
  "simpleDiscordBot",
  "trigger-dev-workflows",
  "homeserver",
  "datacrew-private-memories",
  "trigger.dev",
];

export const repoHygiene = schedules.task({
  id: "repo-hygiene-nightly",
  cron: {
    pattern: "0 0 * * *", // midnight America/Denver
    timezone: "America/Denver",
  },
  ttl: "15m",
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 2 },
  run: async () => {
    logger.info("starting repo-hygiene detection sweep");

    const githubPat = await getSecret("JAEWILSON07_GH_PAT");
    const slackToken = await getSecret("DATACREW_SLACK_BOT_TOKEN");
    const slackChannel = process.env.REPO_HYGIENE_CHANNEL ?? "C0C49TXMD19";
    const slackThreadTs = process.env.REPO_HYGIENE_THREAD_TS;

    const baseDir = path.join(os.homedir(), "GitHub");
    const findings: BranchFinding[] = [];

    // --- Detection sweep ---
    for (const repo of REPOS_TO_SCAN) {
      if (EXCLUSIONS.includes(repo)) continue;
      
      const repoPath = path.join(baseDir, repo);
      try {
        const repoFindings = await scanRepo(repoPath, repo, githubPat);
        findings.push(...repoFindings);
      } catch (err) {
        logger.error(`failed to scan ${repo}`, { error: String(err) });
      }
    }

    logger.info("detection sweep complete", { findingCount: findings.length });

    if (findings.length === 0) {
      logger.info("no findings — healthy state");
      return { scannedRepos: REPOS_TO_SCAN.length, totalFindings: 0 };
    }

    // --- Auto-GHOST pre-filter ---
    const autoGhost = findings.filter(f => f.isFullyMerged);
    const needsTriage = findings.filter(f => !f.isFullyMerged);

    logger.info("pre-filtered auto-GHOST branches", {
      autoGhostCount: autoGhost.length,
      needsTriageCount: needsTriage.length,
    });

    // --- Rizz triage (LLM call) ---
    let triageResults: Array<{ finding: BranchFinding; verdict: RizzVerdict }> = [];
    
    try {
      triageResults = await runRizzTriage(needsTriage);
    } catch (err) {
      logger.error("rizz triage failed, reporting raw findings", { error: String(err) });
      // Fall back to raw reporting
      triageResults = needsTriage.map(f => ({
        finding: f,
        verdict: {
          verdict: "ghost" as const,
          confidence: "low" as const,
          what_this_was: "untriaged — LLM call failed",
          where_it_stopped: "detection only",
          next_step: "manual review",
          evidence: "triage error",
        },
      }));
    }

    // Add auto-GHOST findings
    const autoGhostResults = autoGhost.map(f => ({
      finding: f,
      verdict: {
        verdict: "ghost" as const,
        confidence: "high" as const,
        what_this_was: "already merged into main",
        where_it_stopped: "work landed",
        next_step: "auto-prune after 7-day grace",
        evidence: `git branch --merged origin/main`,
      },
    }));

    const allResults = [...triageResults, ...autoGhostResults];

    // --- Tiered routing ---
    const resume = allResults.filter(r => r.verdict.verdict === "resume");
    const ghosts = allResults.filter(r => r.verdict.verdict === "ghost");
    const stale = allResults.filter(r => r.verdict.verdict === "stale");

    // Cap resume issues at 10
    const resumeToIssue = resume.slice(0, 10);
    const resumeOverflow = resume.slice(10);

    logger.info("triage complete", {
      resume: resume.length,
      ghost: ghosts.length,
      stale: stale.length,
      cappedResume: resumeToIssue.length,
      overflow: resumeOverflow.length,
    });

    // --- File resume issues ---
    let issueCount = 0;
    for (const r of resumeToIssue) {
      try {
        await fileReadyForHumanIssue(r.finding, r.verdict, githubPat);
        issueCount++;
      } catch (err) {
        logger.error(`failed to file issue for ${r.finding.repo}/${r.finding.branch}`, { error: String(err) });
      }
    }

    // --- Auto-prune merged branches with 7-day grace + tip-SHA guard ---
    const autoPruned: BranchFinding[] = [];
    const autoPruneBlocked: BranchFinding[] = [];
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    for (const g of ghosts) {
      const f = g.finding;
      if (f.prStatus === "MERGED" && f.prMergedAt) {
        const mergedAt = new Date(f.prMergedAt).getTime();
        const daysSinceMerge = (now - mergedAt) / (24 * 60 * 60 * 1000);

        if (daysSinceMerge >= 7) {
          // Tip-SHA guard
          if (f.tipSha === f.prHeadSha) {
            try {
              await autoPruneBranch(f, githubPat);
              autoPruned.push(f);
            } catch (err) {
              logger.error(`auto-prune failed for ${f.repo}/${f.branch}`, { error: String(err) });
            }
          } else {
            // SHA mismatch — post-merge work detected
            autoPruneBlocked.push(f);
          }
        }
      }
    }

    logger.info("auto-prune complete", {
      pruned: autoPruned.length,
      blocked: autoPruneBlocked.length,
    });

    // --- Post Slack digest ---
    const digestLines: string[] = [":broom: *Nightly repo hygiene digest*"];

    if (autoPruned.length > 0) {
      digestLines.push("\n*Auto-pruned* (7+ days post-merge, SHA verified):");
      for (const f of autoPruned) {
        digestLines.push(`  • \`${f.repo}/${f.branch}\` — merged ${f.prMergedAt}`);
      }
    }

    if (autoPruneBlocked.length > 0) {
      digestLines.push("\n*:warning: Merged but modified post-close — human review required*:");
      for (const f of autoPruneBlocked) {
        digestLines.push(`  • \`${f.repo}/${f.branch}\` — tip SHA ≠ PR head SHA`);
      }
    }

    if (ghosts.filter(g => g.finding.prStatus !== "MERGED").length > 0) {
      digestLines.push("\n*Ghost branches* (merged/trivial experiment):");
      for (const g of ghosts.filter(g => g.finding.prStatus !== "MERGED")) {
        digestLines.push(
          `  • \`${g.finding.repo}/${g.finding.branch}\` — ${g.finding.commitsAhead} commits, last ${g.finding.lastCommitDate}`
        );
        digestLines.push(`    _Reply \`delete ${g.finding.repo} ${g.finding.branch}\` to remove._`);
      }
    }

    if (stale.length > 0) {
      digestLines.push("\n*Stale branches* (60+ days, no links, overlapping work):");
      for (const s of stale) {
        digestLines.push(`  • \`${s.finding.repo}/${s.finding.branch}\` — last ${s.finding.lastCommitDate}`);
        digestLines.push(`    _Reply \`delete ${s.finding.repo} ${s.finding.branch}\` to remove._`);
      }
    }

    if (resumeToIssue.length > 0) {
      digestLines.push("\n*Resume issues filed*:");
      for (const r of resumeToIssue) {
        digestLines.push(`  • \`${r.finding.repo}/${r.finding.branch}\` → issue filed`);
      }
    }

    if (resumeOverflow.length > 0) {
      digestLines.push(
        `\n:warning: *${resumeOverflow.length} additional resume findings not issued — cap reached* (branches: ${resumeOverflow.map(r => r.finding.branch).join(", ")})`
      );
    }

    if (digestLines.length > 1) {
      await postSlackDigest(digestLines.join("\n"), slackToken, slackChannel, slackThreadTs);
    }

    return {
      scannedRepos: REPOS_TO_SCAN.length,
      totalFindings: findings.length,
      resumeCount: resume.length,
      ghostCount: ghosts.length,
      staleCount: stale.length,
      issuesFiled: issueCount,
      autoPruned: autoPruned.length,
      autoPruneBlocked: autoPruneBlocked.length,
    };
  },
});

// --- Detection helpers ---

async function scanRepo(
  repoPath: string,
  repoName: string,
  githubPat: string
): Promise<BranchFinding[]> {
  const findings: BranchFinding[] = [];
  const stat = await fs.stat(repoPath).catch(() => null);
  if (!stat?.isDirectory()) return findings;

  const gitDir = path.join(repoPath, ".git");
  const isGit = await fs.stat(gitDir).catch(() => null);
  if (!isGit) return findings;

  const cwd = { cwd: repoPath };

  // Get default branch
  const { stdout: defaultBranch } = await execAsync(
    `git rev-parse --abbrev-ref origin/HEAD`,
    cwd
  ).catch(() => ({ stdout: "origin/main" }));
  const mainBranch = defaultBranch.trim().replace("origin/", "");

  // Get all local branches
  const { stdout: branches } = await execAsync(
    `git for-each-ref --format='%(refname:short)' refs/heads/`,
    cwd
  );

  // Get branches fully merged into origin/main (auto-GHOST candidates)
  const { stdout: mergedBranches } = await execAsync(
    `git branch --merged origin/${mainBranch} --format='%(refname:short)'`,
    cwd
  );
  const mergedSet = new Set(mergedBranches.split("\n").map(b => b.trim()).filter(Boolean));

  for (const branch of branches.split("\n").map(b => b.trim()).filter(Boolean)) {
    if (branch === mainBranch) continue;

    // Get commit info
    const { stdout: commitInfo } = await execAsync(
      `git log -1 --format='%H|%ci|%s' ${branch}`,
      cwd
    ).catch(() => ({ stdout: "|" }));
    const [tipSha = "", lastCommitDate = "", lastCommitMessage = ""] = commitInfo.split("|");

    // Get commits ahead of main
    const { stdout: ahead } = await execAsync(
      `git rev-list --count origin/${mainBranch}..${branch}`,
      cwd
    ).catch(() => ({ stdout: "0" }));
    const commitsAhead = parseInt(ahead.trim(), 10);

    // Get diffstat
    const { stdout: diffstat } = await execAsync(
      `git diff --stat origin/${mainBranch}...${branch} | tail -1`,
      cwd
    ).catch(() => ({ stdout: "" }));

    // Get age
    const lastCommit = new Date(lastCommitDate || "1970-01-01");
    const age = Math.floor((Date.now() - lastCommit.getTime()) / (24 * 60 * 60 * 1000));

    // Get PR status via gh CLI
    let prStatus: BranchFinding["prStatus"] = "NONE";
    let prNumber: number | undefined;
    let prHeadSha: string | undefined;
    let prMergedAt: string | undefined;

    try {
      const { stdout: prInfo } = await execAsync(
        `gh pr list --head ${branch} --state all --json number,state,headRefOid,mergedAt --jq '.[0]'`,
        { ...cwd, env: { ...process.env, GH_TOKEN: githubPat } }
      );
      if (prInfo && prInfo !== "null") {
        const pr = JSON.parse(prInfo);
        prNumber = pr.number;
        prHeadSha = pr.headRefOid;
        prMergedAt = pr.mergedAt;
        prStatus = pr.state === "OPEN" ? "OPEN" : pr.state === "MERGED" ? "MERGED" : "CLOSED";
      }
    } catch {
      // gh CLI not available or no PR
    }

    // Check if upstream fork branch (digest-only)
    const isUpstreamForkBranch =
      UPSTREAM_FORK_REPOS.includes(repoName) && branch.includes("local-customization");

    findings.push({
      repo: repoName,
      clonePath: repoPath,
      branch,
      tipSha,
      commitsAhead,
      lastCommitDate,
      lastCommitMessage,
      diffstat,
      prStatus,
      prNumber,
      prHeadSha,
      prMergedAt,
      isFullyMerged: mergedSet.has(branch),
      age,
    });
  }

  return findings;
}

async function runRizzTriage(
  findings: BranchFinding[]
): Promise<Array<{ finding: BranchFinding; verdict: RizzVerdict }>> {
  // TODO: Implement LLM-powered triage using gateway qwen3.5-9b
  // For now, use heuristics from spec
  return findings.map(f => {
    // Stale: 60+ days, no links, overlapping work
    if (f.age >= 60 && f.prStatus === "NONE" && f.commitsAhead > 0) {
      return {
        finding: f,
        verdict: {
          verdict: "stale",
          confidence: "medium",
          what_this_was: "old branch with no PR or linked issues",
          where_it_stopped: `last commit ${f.lastCommitDate}`,
          next_step: "review for deletion",
          evidence: `${f.age} days old, no PR`,
        },
      };
    }

    // Ghost: trivial experiment
    if (f.commitsAhead <= 2 && f.prStatus === "NONE") {
      return {
        finding: f,
        verdict: {
          verdict: "ghost",
          confidence: "high",
          what_this_was: "trivial experiment",
          where_it_stopped: "few commits, no narrative",
          next_step: "delete if not needed",
          evidence: `${f.commitsAhead} commits, no PR`,
        },
      };
    }

    // Default: resume
    return {
      finding: f,
      verdict: {
        verdict: "resume",
        confidence: "medium",
        what_this_was: "active work in progress",
        where_it_stopped: f.lastCommitMessage,
        next_step: "check if still needed",
        evidence: `commits ahead: ${f.commitsAhead}`,
      },
    };
  });
}

async function fileReadyForHumanIssue(
  finding: BranchFinding,
  verdict: RizzVerdict,
  githubPat: string
): Promise<void> {
  const title = `Resume work on ${finding.branch}`;
  const body = `
**What this was:** ${verdict.what_this_was}

**Where it stopped:** ${verdict.where_it_stopped}

**Next step:** ${verdict.next_step}

**Evidence:** ${verdict.evidence}

---
*Branch:* \`${finding.branch}\` (${finding.commitsAhead} commits ahead of main)
*Last commit:* ${finding.lastCommitDate}
*Auto-generated by repo-hygiene task*
`.trim();

  await execAsync(
    `gh issue create --title "${title}" --body "${body.replace(/"/g, '\\"')}" --label "ready-for-human"`,
    {
      cwd: finding.clonePath,
      env: { ...process.env, GH_TOKEN: githubPat },
    }
  );

  logger.info(`filed ready-for-human issue`, { repo: finding.repo, branch: finding.branch });
}

async function autoPruneBranch(finding: BranchFinding, githubPat: string): Promise<void> {
  // Delete local branch
  await execAsync(`git branch -D ${finding.branch}`, { cwd: finding.clonePath });

  // Delete remote branch if exists
  try {
    await execAsync(`git push origin --delete ${finding.branch}`, {
      cwd: finding.clonePath,
      env: { ...process.env, GH_TOKEN: githubPat },
    });
  } catch {
    // Remote branch may not exist
  }

  logger.info(`auto-pruned branch`, { repo: finding.repo, branch: finding.branch });
}

async function postSlackDigest(
  text: string,
  slackToken: string,
  channel: string,
  threadTs?: string
): Promise<void> {
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Slack API error: ${res.status}`);
  }

  logger.info("posted Slack digest", { channel, threadTs });
}
