import { task, logger } from "@trigger.dev/sdk";
import { listContainers } from "../../lib/host-commands.js";
import { SERVICE_GROUPS } from "../../lib/infra-health.js";
import type { InfraCheckPayload, ServiceGroupResult } from "../../lib/infra-health.js";

/**
 * Are the critical containers running on each host?
 *
 * The second of three independent checks. As its own task, a `docker ps`
 * failure now degrades ONLY this check — previously it degraded all three
 * results to `"unknown"` in one code path, because the three lived in one
 * function and shared one failure mode.
 *
 * Since 2026-09-06 this uses the Docker Engine API over HTTP
 * (`docker-socket-proxy:2375/containers/json`) instead of shelling out to
 * `docker ps`, because the Trigger.dev task container has no Docker CLI.
 * The CLI remains as a fallback for local `trigger dev` runs.
 *
 * REMOTE HOSTS: Groups with `remote: true` (cubby) cannot be checked via the
 * local Docker API — cubby is a separate host. These groups report `unknown`
 * with a pointer to the endpoint checks that DO cover cubby services.
 */
export type CheckServiceGroupsResult = { results: ServiceGroupResult[] };

export const checkServiceGroups = task({
  id: "check-service-groups",
  // `docker ps` is either available or it is not — a retry cannot change that,
  // and this check has no network dependency that could be transient.
  retry: { maxAttempts: 1 },
  run: async (_payload: InfraCheckPayload): Promise<CheckServiceGroupsResult> => {
    logger.info("starting check-service-groups");

    // Remote groups (cubby) can't be checked from bonker's Docker API.
    const localGroups = SERVICE_GROUPS.filter((g) => !g.remote);
    const remoteGroups = SERVICE_GROUPS.filter((g) => g.remote);

    const remoteResults: ServiceGroupResult[] = remoteGroups.map((group) => ({
      name: group.name,
      status: "unknown" as const,
      expected: group.expected,
      running: [],
      missing: [],
      note: "remote host — checked via endpoint readiness probes (see Endpoint readiness section)",
    }));

    if (localGroups.length === 0) {
      return { results: remoteResults };
    }

    const dockerPs = await listContainers();

    if (!dockerPs.ok) {
      const note = dockerPs.stderr || "docker API failed";
      logger.warn("check-service-groups: docker unavailable", { note });
      return {
        results: [
          ...localGroups.map((group) => ({
            name: group.name,
            status: "unknown" as const,
            expected: group.expected,
            running: [],
            missing: [],
            note,
          })),
          ...remoteResults,
        ],
      };
    }

    const running = dockerPs.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const localResults: ServiceGroupResult[] = localGroups.map((group) => {
      const missing = group.expected.filter((service) => !running.includes(service));
      return {
        name: group.name,
        status: (missing.length === 0 ? "healthy" : "degraded") as ServiceGroupResult["status"],
        expected: group.expected,
        running: running.filter((service) => group.expected.includes(service)),
        missing,
        note:
          missing.length === 0
            ? "all critical containers are running"
            : "one or more critical containers are missing",
      };
    });

    const results = [...localResults, ...remoteResults];

    logger.info("check-service-groups: complete", {
      degraded: results.filter((r) => r.status === "degraded").map((r) => r.name),
      unknown: results.filter((r) => r.status === "unknown").map((r) => r.name),
    });

    return { results };
  },
});
