import { runCubbyJob, type RunCubbyJobDeps } from "./cubbyRunJob.js";

/**
 * Is prod Paperclip's Claude Code subscription login still good? (DAT-1999)
 *
 * The probe itself lives on cubby (infra-baseline `runbooks/paperclip-claude-auth`, reached through
 * run-job's `paperclip-claude-auth` job). It prints one JSON line of booleans and expiry timestamps,
 * never a token, and costs no inference. This module parses that line and decides whether to alert.
 *
 * `claude auth status` alone is not enough: it reports loggedIn=true for an expired access token and
 * for a refresh token past its end date, and flips to false only after a failed refresh has already
 * broken every claude_local run. The refresh token's hard end date (`refreshTokenExpiresAt`, 30 days
 * after login and not extended by refreshing) is the early warning, so the verdict also uses it.
 */

export const PROBE_JOB = "paperclip-claude-auth";
/** Warn this long before the refresh token's end date, so a human re-logs in with time to spare. */
export const WARN_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClaudeAuthProbe {
  probe: "claude-auth";
  checkedAt: number;
  loggedIn: boolean | null;
  authMethod: string | null;
  hasRefreshToken: boolean;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  credentialsMtime: number | null;
  error: string | null;
}

export type AuthVerdict =
  | { status: "ok"; refreshTokenExpiresAt: number | null }
  | { status: "expiring"; refreshTokenExpiresAt: number; reasons: string[] }
  | { status: "down"; reasons: string[] };

export class ProbeOutputError extends Error {
  override name = "ProbeOutputError";
}

const nullableNumber = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));

/** Pull the probe's JSON line out of the job output (run-job may add its own stderr lines around it). */
export function parseProbeOutput(output: string): ClaudeAuthProbe {
  const line = output.split("\n").find((l) => l.trim().startsWith("{") && l.includes('"probe":"claude-auth"'));
  if (!line) throw new ProbeOutputError("no claude-auth probe line in job output");
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new ProbeOutputError("claude-auth probe line is not valid JSON");
  }
  const shapeOk =
    p.probe === "claude-auth" &&
    (p.loggedIn === null || typeof p.loggedIn === "boolean") &&
    typeof p.hasRefreshToken === "boolean" &&
    nullableNumber(p.accessTokenExpiresAt) &&
    nullableNumber(p.refreshTokenExpiresAt) &&
    nullableNumber(p.credentialsMtime) &&
    nullableNumber(p.checkedAt ?? null);
  if (!shapeOk) throw new ProbeOutputError("claude-auth probe line has an unexpected shape");
  return p as unknown as ClaudeAuthProbe;
}

export function judge(p: ClaudeAuthProbe, now: number, warnBeforeMs = WARN_BEFORE_MS): AuthVerdict {
  const down: string[] = [];
  if (p.loggedIn === null) down.push(`could not ask the CLI${p.error ? ` (${p.error})` : ""}`);
  else if (!p.loggedIn) down.push("`claude auth status` says loggedIn=false");
  if (p.loggedIn !== false && !p.hasRefreshToken) down.push("no refresh token in .credentials.json");
  const end = p.refreshTokenExpiresAt;
  if (end !== null && end <= now) down.push(`the refresh token expired at ${new Date(end).toISOString()}`);
  if (down.length > 0) return { status: "down", reasons: down };
  if (end !== null && end - now < warnBeforeMs) {
    return {
      status: "expiring",
      refreshTokenExpiresAt: end,
      reasons: [`the refresh token expires at ${new Date(end).toISOString()}`],
    };
  }
  return { status: "ok", refreshTokenExpiresAt: end };
}

const FIX =
  "Re-login (claude.ai, Max) and write the new .credentials.json into the paperclip host dir; steps: infra-cubby apps/paperclip/AGENTS.md, row \"Claude auth not working\".";

export function alertText(v: Exclude<AuthVerdict, { status: "ok" }>, now: number): string {
  if (v.status === "down") {
    return `:rotating_light: Paperclip's Claude Code login is DOWN: ${v.reasons.join("; ")}. Every claude_local run fails until someone logs in again. ${FIX} (DAT-1999)`;
  }
  const days = Math.max(0, Math.floor((v.refreshTokenExpiresAt - now) / 86_400_000));
  return `:warning: Paperclip's Claude Code login lapses in about ${days} day(s): ${v.reasons.join("; ")}. Refreshing does not extend it, only a new login does. ${FIX} (DAT-1999)`;
}

export type ProbeRun =
  | { status: "skipped"; reason: string }
  | { status: "checked"; verdict: AuthVerdict; alerted: boolean };

export interface RunProbeDeps extends RunCubbyJobDeps {
  notify: (text: string) => Promise<void>;
  now?: () => number;
}

/** Ask cubby, judge, alert. Cubby unreachable is `skipped` (as for every other cubby job), not an alert. */
export async function runClaudeAuthProbe(deps: RunProbeDeps): Promise<ProbeRun> {
  const res = await runCubbyJob(PROBE_JOB, deps);
  if (res.status === "skipped") return { status: "skipped", reason: res.reason };
  const now = (deps.now ?? Date.now)();
  const verdict = judge(parseProbeOutput(res.outputTail), now);
  if (verdict.status === "ok") return { status: "checked", verdict, alerted: false };
  await deps.notify(alertText(verdict, now));
  return { status: "checked", verdict, alerted: true };
}
