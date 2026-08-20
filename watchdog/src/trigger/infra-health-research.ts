import { batch, task, logger } from "@trigger.dev/sdk";
import { checkCliDrift } from "./tasks/check-cli-drift.js";
import { checkServiceGroups } from "./tasks/check-service-groups.js";
import { checkRepoConfigDrift } from "./tasks/check-repo-config-drift.js";
import { checkEndpointHealth } from "./tasks/check-endpoint-health.js";
import { ENDPOINT_TARGETS, endpointUrl, rollUp, SERVICE_GROUPS } from "../lib/infra-health.js";
import type {
  CheckResult,
  EndpointResult,
  InfraHealthReport,
  ServiceGroupResult,
} from "../lib/infra-health.js";

/**
 * The RESEARCH half of the infra health report: gather every check, roll them
 * up, and return an `InfraHealthReport` that knows no destination.
 *
 * ## Why the four checks fan out rather than run in sequence
 *
 * CLI drift, container health, repo-config drift and endpoint readiness are
 * independent — none feeds another — so running them concurrently is free
 * wall-clock. More importantly it gives each one its own retry and its own
 * failure boundary: a GitHub rate limit now costs one `unknown` CLI row
 * instead of blanking the docker check, which is exactly what the old
 * single-function version did.
 *
 * ## Why endpoint readiness is a FOURTH check and not part of the third
 *
 * `check-service-groups` counts containers; `check-endpoint-health` asks a
 * service a question over the network. They fail differently (a missing
 * `docker` binary vs. an unroutable host), they answer differently ("this
 * container is absent" vs. "this gateway says its TTS backend is down"), and
 * on 2026-08-19 the first one reported `healthy` through three separate voice
 * outages while every container ran. Folding the assertion into the name check
 * would have given them one shared failure path again — the exact thing
 * `docs/watchdog-rework.md` decomposed this workflow to stop.
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
    logger.info("starting infra-health-research", { date });

    const {
      runs: [cliRun, serviceRun, repoRun, endpointRun],
    } = await batch.triggerByTaskAndWait([
      { task: checkCliDrift, payload: {} },
      { task: checkServiceGroups, payload: {} },
      { task: checkRepoConfigDrift, payload: {} },
      { task: checkEndpointHealth, payload: {} },
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

    // A check task that DIES gets `unknown` rows carrying the error, same as
    // its three siblings — never a missing section. `unknown` here means "the
    // check did not run", which is a different claim from `degraded` ("the
    // endpoint answered and said no"), and the rollup treats them differently.
    const endpointResults: EndpointResult[] = endpointRun.ok
      ? endpointRun.output.results
      : ENDPOINT_TARGETS.map((target) => ({
          name: target.name,
          url: endpointUrl(target),
          status: "unknown" as const,
          httpStatus: null,
          note: `check-endpoint-health failed: ${errorMessage(endpointRun.error)}`,
          advisories: [],
        }));

    const { overallStatus, warnings } = rollUp(
      cliResults,
      serviceResults,
      repoResults,
      endpointResults
    );

    logger.info("infra-health-research: complete", {
      date,
      overallStatus,
      repoRoot: repoRoot ?? "not-found",
      warnings: warnings.length,
      endpointsNotReady: endpointResults.filter((e) => e.status !== "ok").map((e) => e.name),
    });

    return {
      date,
      generated_at: new Date().toISOString(),
      repoRoot,
      cliResults,
      serviceResults,
      repoResults,
      endpointResults,
      overallStatus,
      warnings,
    };
  },
});
