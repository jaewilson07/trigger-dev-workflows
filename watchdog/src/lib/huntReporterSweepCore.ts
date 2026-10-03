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
