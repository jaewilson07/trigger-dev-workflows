import { task, logger } from "@trigger.dev/sdk";
import { readRepoFile, resolveRepoRoot } from "../../lib/host-commands.js";
import { compareToCheckResult, latestFromSource } from "../../lib/infra-health.js";
import type { CheckResult, InfraCheckPayload } from "../../lib/infra-health.js";

/**
 * Are the image versions pinned in the infra repo behind their upstreams?
 *
 * The third independent check. It reads config files off the FILESYSTEM, which
 * means it only works where the infra monorepo is mounted — a local
 * `trigger dev` run, or a deployed container with `INFRA_MONOREPO_ROOT` bound.
 * Everywhere else it reports `"unknown"` with that as the stated reason rather
 * than pretending to have checked. See `resolveRepoRoot`'s doc comment in
 * `lib/host-commands.ts` for why that is documented rather than fixed here.
 */
export type CheckRepoConfigDriftResult = { repoRoot: string | null; results: CheckResult[] };

const SPECS = [
  {
    name: "caddy release",
    file: "infrastructure/bonker/infrastructure/docker-compose.yml",
    regex: /caddy:([A-Za-z0-9._-]+)/,
    source: "github:caddyserver/caddy",
  },
  {
    name: "cloudflared release",
    file: "infrastructure/bonker/infrastructure/docker-compose.yml",
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
    const repoRoot = await resolveRepoRoot();

    if (!repoRoot) {
      logger.info("check-repo-config-drift: no infra monorepo on this filesystem");
      return {
        repoRoot: null,
        results: [
          {
            name: "Repo-backed config drift",
            status: "unknown",
            current: null,
            latest: null,
            note: "no infra monorepo found — set INFRA_MONOREPO_ROOT, or run this where the repo is mounted",
          },
        ],
      };
    }

    const results: CheckResult[] = [];
    for (const spec of SPECS) {
      try {
        const content = await readRepoFile(repoRoot, spec.file);
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
