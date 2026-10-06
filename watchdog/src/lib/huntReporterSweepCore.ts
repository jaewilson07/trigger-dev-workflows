/**
 * Core of the `mdrag-hunt-reporter-sweep` task (mdrag#1984): one POST to mdrag's
 * `/api/v1/internal/hunt-reporter/sweep`, plus the "stuck for several runs"
 * warning. Pure so it tests without Trigger.dev or the network; the task wires
 * in the credential, the fetch, and the previous run's output.
 *
 * Debounce state rides in the run output (like `siteMonitorCore`): a container
 * has no durable disk and a per-minute secret-store write would abuse Infisical.
 */

export type SweepSummary = { checked: number; behind: number; failed: string[] };

export type SweepState = { consecutiveBehind: number; consecutiveFailed: number };

export type SweepOutput = SweepSummary & SweepState;

/**
 * mdrag's DIRECT address as a task-run container on bonker sees it. Config, not
 * a secret, so it lives here rather than in Infisical (like `SITE_ORIGIN`).
 *
 * Reachable because the trigger supervisor attaches every runner container to
 * `ai-network` (infra-bonker `apps/trigger-dev/worker-delta.docker-compose.yml`,
 * `DOCKER_RUNNER_NETWORKS=webapp,supervisor,ai-network`), and `mdrag-local`
 * listens on 8017 on that network. Verified 2026-10-05 (#251): runner
 * containers are on ai-network, and `GET /api/v1/health` from a trigger
 * container on that network returned 200. Never the wiki host: it strips the
 * secret, and `mdragCall` refuses it.
 */
export const MDRAG_DIRECT_URL = "http://mdrag-local:8017";

/**
 * Where the shared internal secret lives: the same `INTERNAL_SECRET` that
 * mdrag-local itself is started with, in the homeserver Infisical project.
 */
export const INTERNAL_SECRET_REF = { key: "INTERNAL_SECRET", path: "/mdrag" } as const;

/** `MDRAG_URL` overrides the default (e.g. a dev run off bonker); blank means unset. */
export function sweepBaseUrl(env: Record<string, string | undefined>): string {
  return ((env.MDRAG_URL ?? "").trim() || MDRAG_DIRECT_URL).replace(/\/+$/, "");
}

/** Runs in a row (one per minute) a problem must persist before it is warned about. */
export const STUCK_RUNS = 5;

export class SweepRequestError extends Error {}

export type SweepCall = { url: string; headers: Record<string, string> };

export function nextSweepState(summary: SweepSummary, previous: Partial<SweepState> | null): SweepState {
  return {
    consecutiveBehind: summary.behind > 0 ? (previous?.consecutiveBehind ?? 0) + 1 : 0,
    consecutiveFailed: summary.failed.length > 0 ? (previous?.consecutiveFailed ?? 0) + 1 : 0,
  };
}

export async function runHuntReporterSweep(deps: {
  call: SweepCall;
  fetchImpl?: typeof fetch;
  previous: () => Promise<Partial<SweepState> | null>;
  warn: (message: string, data: Record<string, unknown>) => void;
}): Promise<SweepOutput> {
  const res = await (deps.fetchImpl ?? fetch)(deps.call.url, {
    method: "POST",
    headers: deps.call.headers,
    body: "{}",
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok) {
    // Body is mdrag's detail string, never our secret. A refusal here (403) is a
    // config error, so it throws and the run fails visibly.
    throw new SweepRequestError(`hunt-reporter sweep failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as Partial<SweepSummary>;
  if (typeof body.checked !== "number" || typeof body.behind !== "number" || !Array.isArray(body.failed)) {
    throw new SweepRequestError(`hunt-reporter sweep returned an unexpected shape: ${JSON.stringify(body)}`);
  }
  const summary: SweepSummary = { checked: body.checked, behind: body.behind, failed: body.failed };
  const state = nextSweepState(summary, await deps.previous());

  if (state.consecutiveBehind >= STUCK_RUNS) {
    deps.warn("hunt reporter is still behind", { behind: summary.behind, consecutiveRuns: state.consecutiveBehind });
  }
  if (state.consecutiveFailed >= STUCK_RUNS) {
    deps.warn("hunt reporter passes keep failing", { failed: summary.failed, consecutiveRuns: state.consecutiveFailed });
  }
  return { ...summary, ...state };
}
