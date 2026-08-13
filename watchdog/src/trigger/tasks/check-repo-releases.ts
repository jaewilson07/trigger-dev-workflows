import { task, logger } from "@trigger.dev/sdk";
import {
  fetchLatestReleases,
  fetchRecentCommits,
  isNotableCommit,
} from "../../lib/repo-monitor.js";
import type { RepoMonitorResult, RepoTarget } from "../../lib/repo-monitor.js";

/**
 * Check a single GitHub repo for new releases and notable commits.
 *
 * Uses the GitHub REST API (no auth needed for public repos with reasonable
 * rate limits). Compares against `lastKnownTag` and `lastKnownSha` to determine
 * what's new.
 *
 * A commit is "notable" if its message contains keywords relevant to our setup
 * (adapter, heartbeat, secret, api, docker, skill, breaking, etc.). This
 * filters out cosmetic/UI-only changes that don't affect our deployment.
 */
export type CheckRepoReleasesPayload = {
  target: RepoTarget;
};

export type CheckRepoReleasesResult = RepoMonitorResult;

export const checkRepoReleases = task({
  id: "check-repo-releases",
  retry: { maxAttempts: 2 },
  run: async (payload: CheckRepoReleasesPayload): Promise<CheckRepoReleasesResult> => {
    const { target } = payload;
    logger.info("starting check-repo-releases", { repo: target.repo });

    logger.info("check-repo-releases: fetching", { repo: target.repo });

    const [releases, commits] = await Promise.all([
      fetchLatestReleases(target.repo, 3).catch((err) => {
        logger.warn("check-repo-releases: release fetch failed", {
          repo: target.repo,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }),
      fetchRecentCommits(target.repo, 15).catch((err) => {
        logger.warn("check-repo-releases: commit fetch failed", {
          repo: target.repo,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }),
    ]);

    const latestRelease = releases.length > 0 ? releases[0] : null;
    const hasNewRelease =
      latestRelease !== null &&
      (target.lastKnownTag === null || latestRelease.tag !== target.lastKnownTag);

    // Filter commits to those since lastKnownSha (or all if no cache)
    const newCommits = target.lastKnownSha
      ? commits.filter((c) => c.sha !== target.lastKnownSha)
      : commits;

    // Further filter to notable commits only
    const notableNewCommits = newCommits.filter(isNotableCommit);

    logger.info("check-repo-releases: complete", {
      repo: target.repo,
      hasNewRelease,
      latestTag: latestRelease?.tag ?? "none",
      newCommits: newCommits.length,
      notableCommits: notableNewCommits.length,
    });

    return {
      repo: target.repo,
      latestRelease,
      recentCommits: commits,
      hasNewRelease,
      newCommits: notableNewCommits,
    };
  },
});
