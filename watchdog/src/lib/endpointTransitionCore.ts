/**
 * State-change-only alerting for endpoint checks (trigger-dev-workflows#273).
 *
 * The alert channel was drowning in identical repeats (datacrew.space at 1,886
 * consecutive). Here a run alerts ONLY when an endpoint's up/down state differs
 * from the previous run's: ok -> not-ok is one alert, not-ok -> ok is one
 * recovery, and a still-down endpoint is silent. `degraded` and `unknown` both
 * count as "down"; a degraded -> unknown change is not a transition.
 */
import type { EndpointResult } from "./infra-health.js";

export type EndpointState = Record<string, "up" | "down">;

export type TransitionDecision = { state: EndpointState; messages: string[] };

const toState = (r: EndpointResult): "up" | "down" => (r.status === "ok" ? "up" : "down");

export function decideTransitions(previous: EndpointState | null, results: EndpointResult[]): TransitionDecision {
  const state: EndpointState = {};
  const messages: string[] = [];
  for (const r of results) {
    const now = toState(r);
    state[r.name] = now;
    const before = previous?.[r.name];
    if (before === now) continue;
    // No baseline for this endpoint: stay quiet when healthy, say so once when not.
    if (before === undefined && now === "up") continue;
    messages.push(
      now === "down"
        ? `:rotating_light: ${r.name} is ${r.status === "unknown" ? "unreachable" : "unhealthy"} — ${r.note}`
        : `:white_check_mark: ${r.name} is healthy again — ${r.note}`
    );
  }
  return { state, messages };
}
