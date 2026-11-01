import { schedules, logger } from "@trigger.dev/sdk";
import { ENDPOINT_TARGETS, endpointUrl, evaluateReadiness, probeEndpoint } from "../lib/infra-health.js";
import type { EndpointResult } from "../lib/infra-health.js";
import { decideTransitions } from "../lib/endpointTransitionCore.js";
import type { EndpointState } from "../lib/endpointTransitionCore.js";
import { postSlackAlert } from "../lib/slackAlert.js";
import { previousRunOutput } from "./tasks/previous-run-output.js";

/**
 * Uptime check for the LiveKit server and jarvis.datacrew.space
 * (trigger-dev-workflows#273). Posts to Slack on state TRANSITIONS only —
 * logic and rationale in `../lib/endpointTransitionCore.ts`. State lives in
 * the previous run's output, same as `site-synthetic-check`.
 */
const SELF_ID = "endpoint-transition-monitor";

export const endpointTransitionMonitor = schedules.task({
  id: SELF_ID,
  cron: { pattern: "*/5 * * * *", environments: ["PRODUCTION"] },
  retry: { maxAttempts: 1 },
  run: async (): Promise<{ results: EndpointResult[]; state: EndpointState; alerts: number }> => {
    logger.info("starting endpoint-transition-monitor");
    const targets = ENDPOINT_TARGETS.filter((t) => t.alertOnTransition);
    const results: EndpointResult[] = [];
    for (const target of targets) {
      const url = endpointUrl(target);
      results.push(evaluateReadiness(target.name, url, await probeEndpoint(url), target.evaluator));
    }
    const previous = (await previousRunOutput<{ state?: EndpointState }>(SELF_ID))?.state ?? null;
    const { state, messages } = decideTransitions(previous, results);
    for (const text of messages) await postSlackAlert(text);
    logger.info("completed endpoint-transition-monitor", { state, alerts: messages.length });
    return { results, state, alerts: messages.length };
  },
});
