import { batch, task, logger } from "@trigger.dev/sdk";
import { checkCliDrift } from "./tasks/check-cli-drift.js";
import { checkServiceGroups } from "./tasks/check-service-groups.js";
import { checkRepoConfigDrift } from "./tasks/check-repo-config-drift.js";
import { rollUp, SERVICE_GROUPS } from "../lib/infra-health.js";
import type { CheckResult, InfraHealthReport, ServiceGroupResult } from "../lib/infra-health.js";

/**
 * The RESEARCH half of the infra health report: gather every check, roll them
 * up, and return an `InfraHealthReport` that knows no destination.
 *
 * ## Why the three checks fan out rather than run in sequence
 *
 * CLI drift, container health and repo-config drift are independent — none
 * feeds another — so running them concurrently is free wall-clock. More
 * importantly it gives each one its own retry and its own failure boundary: a
 * GitHub rate limit now costs one `unknown` CLI row instead of blanking the
 * docker check, which is exactly what the old single-function version did.
 *
 * `batch.triggerByTaskAndWait`, not `Promise.all`: wrapping `triggerAndWait` in
 * `Promise.all` is unsupported, and the batch form isolates failures as
 * `runs[i].ok === false` rather than rejecting the whole call.
 *
 * ## A failed check is a reported check
 *
 * If a check task dies outright (rather than returning `unknown` rows, which is
 * its normal way of saying "could not tell"), this records that as `unknown`
 * with the error text and carries on. A health report that fails to render
 * because one of its three sections broke is strictly worse than one that says
 * "I could not check containers, here is everything else".
 */
export type InfraHealthResearchPayload = {
  /** `YYYY-MM-DD` the report is about. Defaults to today in UTC. */
  date?: string;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

export const infraHealthResearch = task({
  id: "infra-health-research",
  // The children retry independently; re-running this would re-run all three.
  retry: { maxAttempts: 1 },
  run: async (payload: InfraHealthResearchPayload): Promise<InfraHealthReport> => {
    const date = payload.date ?? new Date().toISOString().slice(0, 10);

    const {
      runs: [cliRun, serviceRun, repoRun],
    } = await batch.triggerByTaskAndWait([
      { task: checkCliDrift, payload: {} },
      { task: checkServiceGroups, payload: {} },
      { task: checkRepoConfigDrift, payload: {} },
    ]);

    const cliResults: CheckResult[] = cliRun.ok
      ? cliRun.output.results
      : [
          {
            name: "CLI drift",
            status: "unknown",
            current: null,
            latest: null,
            note: `check-cli-drift failed: ${errorMessage(cliRun.error)}`,
          },
        ];

    const serviceResults: ServiceGroupResult[] = serviceRun.ok
      ? serviceRun.output.results
      : SERVICE_GROUPS.map((group) => ({
          name: group.name,
          status: "unknown" as const,
          expected: group.expected,
          running: [],
          missing: [],
          note: `check-service-groups failed: ${errorMessage(serviceRun.error)}`,
        }));

    const repoRoot = repoRun.ok ? repoRun.output.repoRoot : null;
    const repoResults: CheckResult[] = repoRun.ok
      ? repoRun.output.results
      : [
          {
            name: "Repo-backed config drift",
            status: "unknown",
            current: null,
            latest: null,
            note: `check-repo-config-drift failed: ${errorMessage(repoRun.error)}`,
          },
        ];

    const { overallStatus, warnings } = rollUp(cliResults, serviceResults, repoResults);

    logger.info("infra-health-research: complete", {
      date,
      overallStatus,
      repoRoot: repoRoot ?? "not-found",
      warnings: warnings.length,
    });

    return {
      date,
      generated_at: new Date().toISOString(),
      repoRoot,
      cliResults,
      serviceResults,
      repoResults,
      overallStatus,
      warnings,
    };
  },
});
