import { task, logger } from "@trigger.dev/sdk";
import { runCommand } from "../../lib/host-commands.js";
import { CLI_TARGETS, compareToCheckResult, latestFromSource } from "../../lib/infra-health.js";
import type { CheckResult, InfraCheckPayload } from "../../lib/infra-health.js";

/**
 * Is each installed CLI at the latest published version?
 *
 * One of three independent checks that used to be sequential statements inside
 * a 497-line task. As its own task it gets its own retry (a GitHub API rate
 * limit is transient and should not blank the docker check), its own timing in
 * the dashboard, and its own failure boundary.
 *
 * A CLI that is not installed is `"unknown"` WITH THE REASON, not an error:
 * this task runs in whatever environment the schedule runs in, and a deployed
 * container legitimately has none of these binaries.
 */
export type CheckCliDriftResult = { results: CheckResult[] };

/**
 * `--version` output varies per tool. Infisical prints a labelled line, the
 * other two print a bare semver among other text — so the first bare semver is
 * the right general rule and Infisical gets the specific one.
 */
function parseVersion(name: string, output: string): string | null {
  if (name === "Infisical CLI") {
    return output.match(/infisical version ([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null;
  }
  return output.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null;
}

export const checkCliDrift = task({
  id: "check-cli-drift",
  retry: { maxAttempts: 2 },
  run: async (_payload: InfraCheckPayload): Promise<CheckCliDriftResult> => {
    logger.info("starting check-cli-drift");
    const results: CheckResult[] = [];

    for (const target of CLI_TARGETS) {
      const run = await runCommand(target.command, [...target.args]);
      if (!run.ok) {
        results.push({
          name: target.name,
          status: "unknown",
          current: null,
          latest: null,
          note: run.stderr || `\`${target.command} ${target.args.join(" ")}\` failed`,
        });
        continue;
      }

      const current = parseVersion(target.name, run.stdout);
      // A registry lookup that fails is caught, not thrown: one unreachable
      // registry should cost one `unknown` row, not the whole check.
      const latest = await latestFromSource(target.source).catch((err) => {
        logger.warn("check-cli-drift: registry lookup failed", {
          name: target.name,
          source: target.source,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });

      results.push(compareToCheckResult(target.name, current, latest));
    }

    logger.info("check-cli-drift: complete", {
      outOfDate: results.filter((r) => r.status === "out-of-date").map((r) => r.name),
      unknown: results.filter((r) => r.status === "unknown").map((r) => r.name),
    });

    return { results };
  },
});
