import { task, logger } from "@trigger.dev/sdk";
import { runCommand } from "../../lib/host-commands.js";
import { SERVICE_GROUPS } from "../../lib/infra-health.js";
import type { InfraCheckPayload, ServiceGroupResult } from "../../lib/infra-health.js";

/**
 * Are the critical containers running on each host?
 *
 * The second of three independent checks. As its own task, a `docker ps`
 * failure now degrades ONLY this check — previously it degraded all three
 * results to `"unknown"` in one code path, because the three lived in one
 * function and shared one failure mode.
 */
export type CheckServiceGroupsResult = { results: ServiceGroupResult[] };

export const checkServiceGroups = task({
  id: "check-service-groups",
  // `docker ps` is either available or it is not — a retry cannot change that,
  // and this check has no network dependency that could be transient.
  retry: { maxAttempts: 1 },
  run: async (_payload: InfraCheckPayload): Promise<CheckServiceGroupsResult> => {
    const dockerPs = await runCommand("docker", ["ps", "--format", "{{.Names}}"]);

    if (!dockerPs.ok) {
      const note = dockerPs.stderr || "docker ps failed";
      logger.warn("check-service-groups: docker unavailable", { note });
      return {
        results: SERVICE_GROUPS.map((group) => ({
          name: group.name,
          status: "unknown",
          expected: group.expected,
          running: [],
          // `missing` stays EMPTY when the status is unknown. The old version
          // set it to the full expected list, which read as "every container is
          // down" on a dashboard that only showed `missing` — a false alarm
          // indistinguishable from a real outage.
          missing: [],
          note,
        })),
      };
    }

    const running = dockerPs.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const results = SERVICE_GROUPS.map((group) => {
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

    logger.info("check-service-groups: complete", {
      degraded: results.filter((r) => r.status === "degraded").map((r) => r.name),
    });

    return { results };
  },
});
