import { task, logger } from "@trigger.dev/sdk";
import {
  ENDPOINT_TARGETS,
  endpointUrl,
  evaluateReadiness,
  probeEndpoint,
} from "../../lib/infra-health.js";
import type { EndpointResult, InfraCheckPayload } from "../../lib/infra-health.js";

/**
 * Do the endpoints this estate depends on actually SAY they are serving?
 *
 * The fourth independent check, and the only one that asks a service a
 * question rather than counting things. `check-service-groups` asks `docker
 * ps` whether a container called `voice-gateway` exists; this asks the gateway
 * whether it can reach CosyVoice and faster-whisper. The gap between those two
 * questions is three real voice outages on 2026-08-19 (infra-bonker#494,
 * infra-cubby#175, infra-cubby#176), every one of which left this workflow
 * reporting `healthy` while every container ran happily, and every one of
 * which was found instead by a human noticing something felt off.
 *
 * WHY `/ready` AND NOT `/health`. The voice gateway's `/health` is
 * deliberately shallow — it proves the process is up and that voice profiles
 * loaded off disk, and explicitly never touches a backend, so a container
 * healthcheck can poll it hard. It answers `ok` with both GPU backends face
 * down. `/ready` is the deep probe that dials them. Checking the cheap one
 * would have reproduced the bug rather than caught it.
 *
 * WHY IT DOES NOT RETRY. `probeEndpoint` does not throw: a refused connection
 * or a DNS failure comes back as `unreachable` and becomes ONE `unknown` row
 * carrying its own reason. There is nothing left for a task-level retry to
 * rescue, and a watchdog that fails its own run because the thing it watches
 * is unreachable is the exact failure this workflow exists to prevent.
 */
export type CheckEndpointHealthResult = { results: EndpointResult[] };

export const checkEndpointHealth = task({
  id: "check-endpoint-health",
  retry: { maxAttempts: 1 },
  run: async (_payload: InfraCheckPayload): Promise<CheckEndpointHealthResult> => {
    logger.info("starting check-endpoint-health", {
      targets: ENDPOINT_TARGETS.map((target) => target.name),
    });

    const results: EndpointResult[] = [];
    for (const target of ENDPOINT_TARGETS) {
      const url = endpointUrl(target);
      const result = evaluateReadiness(target.name, url, await probeEndpoint(url));

      if (result.status !== "ok") {
        logger.warn("check-endpoint-health: endpoint is not ready", {
          name: result.name,
          url,
          status: result.status,
          httpStatus: result.httpStatus,
          note: result.note,
        });
      }
      // Advisories are logged individually rather than as an array so each one
      // is greppable in the run log on its own, the same way a `degraded` row
      // is. They do not change the verdict — see `readinessAdvisories`.
      for (const advisory of result.advisories) {
        logger.warn("check-endpoint-health: advisory", { name: result.name, url, advisory });
      }

      results.push(result);
    }

    logger.info("check-endpoint-health: complete", {
      degraded: results.filter((r) => r.status === "degraded").map((r) => r.name),
      unknown: results.filter((r) => r.status === "unknown").map((r) => r.name),
      advisories: results.reduce((total, r) => total + r.advisories.length, 0),
    });

    return { results };
  },
});
