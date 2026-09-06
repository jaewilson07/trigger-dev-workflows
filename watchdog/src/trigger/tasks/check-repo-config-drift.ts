import { task, logger } from "@trigger.dev/sdk";
import { fetchHostInfo, fetchRepoFile, readRepoFile, resolveRepoRoot } from "../../lib/host-commands.js";
import { compareToCheckResult, latestFromSource } from "../../lib/infra-health.js";
import type { CheckResult, InfraCheckPayload } from "../../lib/infra-health.js";

/**
 * Are the image versions pinned in the infra repo behind their upstreams?
 *
 * The third independent check. It reads config files from the infra repo.
 * In deployed trigger.dev tasks, it uses the host-info container's /file
 * endpoint to read files (the repo is mounted read-only in host-info).
 * In local `trigger dev` runs, it falls back to reading from the filesystem.
 */
export type CheckRepoConfigDriftResult = { repoRoot: string | null; results: CheckResult[] };

const SPECS = [
  {
    name: "caddy release",
    file: "infrastructure/docker-compose.yml",
    regex: /caddy:([A-Za-z0-9._-]+)/,
    source: "github:caddyserver/caddy",
  },
  {
    name: "cloudflared release",
    file: "infrastructure/docker-compose.yml",
    regex: /cloudflared:([A-Za-z0-9._-]+)/,
    source: "github:cloudflare/cloudflared",
  },
  {
    name: "vllm (llama-swap engines)",
    file: "infrastructure/cubby/apps/llama-swap/config.yaml",
    regex: /vllm\/vllm-openai:v([0-9]+\.[0-9]+\.[0-9]+)/,
    source: "pypi:vllm",
  },
] as const;

export const checkRepoConfigDrift = task({
  id: "check-repo-config-drift",
  // Retried for the same reason as check-cli-drift: the registry lookups are
  // network calls that can rate-limit.
  retry: { maxAttempts: 2 },
  run: async (_payload: InfraCheckPayload): Promise<CheckRepoConfigDriftResult> => {
    logger.info("starting check-repo-config-drift");

    // Try the host-info HTTP endpoint first — works from inside the task container.
    const hostInfo = await fetchHostInfo();
    let repoRoot: string | null = null;
    let useHostInfo = false;

    if (hostInfo?.repo?.exists) {
      repoRoot = hostInfo.repo.path;
      useHostInfo = true;
      logger.info("check-repo-config-drift: using host-info endpoint", { repoRoot });
    } else {
      // Fallback: try filesystem (works in local `trigger dev`)
      repoRoot = await resolveRepoRoot();
      if (!repoRoot) {
        logger.info("check-repo-config-drift: no infra monorepo accessible");
        return {
          repoRoot: null,
          results: [
            {
              name: "Repo-backed config drift",
              status: "unknown",
              current: null,
              latest: null,
              note: "no infra monorepo found — host-info container or INFRA_MONOREPO_ROOT required",
            },
          ],
        };
      }
      logger.info("check-repo-config-drift: using filesystem", { repoRoot });
    }

    const results: CheckResult[] = [];
    for (const spec of SPECS) {
      try {
        let content: string | null;
        if (useHostInfo) {
          content = await fetchRepoFile(spec.file);
        } else {
          content = await readRepoFile(repoRoot!, spec.file);
        }
        if (content === null) {
          results.push({
            name: spec.name,
            status: "unknown",
            current: null,
            latest: null,
            note: `failed reading ${spec.file}`,
          });
          continue;
        }
        const current = content.match(spec.regex)?.[1] ?? null;
        const latest = await latestFromSource(spec.source).catch(() => null);
        results.push(compareToCheckResult(spec.name, current, latest));
      } catch (error) {
        results.push({
          name: spec.name,
          status: "unknown",
          current: null,
          latest: null,
          note: error instanceof Error ? error.message : "failed reading config file",
        });
      }
    }

    logger.info("check-repo-config-drift: complete", {
      repoRoot,
      outOfDate: results.filter((r) => r.status === "out-of-date").map((r) => r.name),
    });

    return { repoRoot, results };
  },
});
