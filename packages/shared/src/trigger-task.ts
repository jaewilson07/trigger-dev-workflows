/**
 * Trigger a Trigger.dev task from OUTSIDE Trigger.dev — a script, a cron, a
 * Letta channel adapter (Rizz) — against our self-hosted instance.
 *
 * This is a different credential and a different call from `syncEnvVars`/
 * `getSecret` in `infisical.ts`: those manage secrets a *task* needs at
 * deploy/run time; this is the per-project TRIGGER SECRET KEY used to call
 * `POST /api/v1/tasks/{id}/trigger` from the outside, reusing `getSecret` for
 * the Infisical half rather than a second Infisical client.
 *
 * Split the same way `mdrag-hop.ts` is: pure "build the call" functions
 * (`buildTriggerRequest`/`buildRunStatusRequest`) that need no network and are
 * what the test drives, plus thin functions that fetch a secret key and
 * actually perform the request. Testing stops at the boundary the rest of
 * this package already draws it at — the fetch call itself is not mocked
 * here, matching `mdragCall`'s own precedent of never performing its own
 * fetch.
 *
 * Extracted 2026-09-13 from `.agents/skills/trigger-project-credentials`'s
 * bash procedure (`.agents/plans/mdrag-shared-api-extraction.md`, Phase 2) —
 * see that skill for the fuller "how the credential is provisioned" story;
 * this module is the "call it from code" half.
 */

import { getSecret } from "./infisical.js";

const TRIGGER_SECRET_PATH = "/trigger";
const DEFAULT_BASE_URL = "https://triggers.datacrew.space";

/**
 * `executive-assistant` — the first Trigger.dev project created — stores its
 * key under the bare name `TRIGGER_SECRET_KEY`, not the prefixed convention
 * every project since has used. Not a pattern to repeat; kept only so this
 * one project's key still resolves.
 */
const LEGACY_BARE_KEY_PROJECTS = new Set(["executive-assistant"]);

export class TriggerTaskError extends Error {}

/** `<PROJECT>_TRIGGER_SECRET_KEY` from a project key name. Exported for the test table. */
export function secretKeyName(projectKeyName: string): string {
  return `${projectKeyName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TRIGGER_SECRET_KEY`;
}

function baseUrlFromEnv(): string {
  return (process.env.TRIGGER_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * Fetch `projectKeyName`'s Trigger.dev prod secret key from Infisical.
 *
 * Tries the prefixed name first (`<PROJECT>_TRIGGER_SECRET_KEY`); falls back
 * to the bare legacy name only for `executive-assistant`. `--recursive`
 * equivalent (`getSecret`'s default) matters here — `/trigger`'s secrets are
 * empirically invisible to a non-recursive lookup at that exact path.
 */
export async function getTriggerSecretKey(projectKeyName: string): Promise<string> {
  const prefixed = secretKeyName(projectKeyName);
  try {
    return await getSecret(prefixed, { path: TRIGGER_SECRET_PATH });
  } catch (err) {
    if (!LEGACY_BARE_KEY_PROJECTS.has(projectKeyName)) throw err;
    return getSecret("TRIGGER_SECRET_KEY", { path: TRIGGER_SECRET_PATH });
  }
}

export type TriggerTaskOptions = {
  queue?: { name: string };
  concurrencyKey?: string;
  delay?: string;
  idempotencyKeyTTL?: string;
  machine?: string;
  maxAttempts?: number;
  maxDuration?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
  ttl?: string;
  priority?: number;
  test?: boolean;
};

export type TriggerTaskResult = {
  /** The run id (`run_...`). Poll it with {@link pollTriggerRun}. */
  id: string;
  /** True if an existing idempotency key matched and no new run was created. */
  isCached: boolean;
};

export type HttpRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
};

/**
 * Build the trigger request: method, URL, headers, body. No I/O — the part
 * every caller must agree on, and what the test drives directly without a
 * secret key or network access.
 *
 * `idempotencyKey` is not optional on purpose: the trigger endpoint is a bare
 * POST with no natural dedupe — a retried call with no idempotency key
 * creates a second run. Pass a key stable across retries of the SAME logical
 * request (e.g. `storm-research:${topic}:${dateKey}`), not a fresh one per
 * call.
 */
export function buildTriggerRequest(
  secretKey: string,
  taskId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  options?: TriggerTaskOptions,
  baseUrl: string = baseUrlFromEnv()
): HttpRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/api/v1/tasks/${encodeURIComponent(taskId)}/trigger`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ payload, options }),
  };
}

/** Build the run-status request: `GET /api/v3/runs/{runId}`. No I/O. */
export function buildRunStatusRequest(
  secretKey: string,
  runId: string,
  baseUrl: string = baseUrlFromEnv()
): HttpRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/api/v3/runs/${encodeURIComponent(runId)}`,
    method: "GET",
    headers: { Authorization: `Bearer ${secretKey}` },
  };
}

/**
 * Trigger one Trigger.dev task, by task identifier, from outside Trigger.dev.
 *
 * Base URL defaults to the public hostname (verified reachable for
 * bearer-authed `/api/*` calls, no Cloudflare Access in front of it) —
 * override with `TRIGGER_API_URL` for a bonker-local caller that wants to
 * skip Caddy/Cloudflare (`http://127.0.0.1:8030`).
 *
 * @throws TriggerTaskError on a non-2xx response. A response naming an
 * unknown task id still returns 200 with a real (permanently pending) run —
 * validate `taskId` client-side; this function cannot catch that for you.
 */
export async function triggerTaskDotDevTask(
  projectKeyName: string,
  taskId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  options?: TriggerTaskOptions
): Promise<TriggerTaskResult> {
  const secretKey = await getTriggerSecretKey(projectKeyName);
  const req = buildTriggerRequest(secretKey, taskId, payload, idempotencyKey, options);

  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  if (!res.ok) {
    throw new TriggerTaskError(
      `triggerTaskDotDevTask: ${projectKeyName}/${taskId} failed with ${res.status}: ${await res.text()}`
    );
  }
  return (await res.json()) as TriggerTaskResult;
}

export type TriggerRunStatus = {
  id: string;
  status: string;
  [key: string]: unknown;
};

/** One-shot run status check: `GET /api/v3/runs/{runId}`. */
export async function getTriggerRun(
  projectKeyName: string,
  runId: string
): Promise<TriggerRunStatus> {
  const secretKey = await getTriggerSecretKey(projectKeyName);
  const req = buildRunStatusRequest(secretKey, runId);

  const res = await fetch(req.url, { headers: req.headers });
  if (!res.ok) {
    throw new TriggerTaskError(`getTriggerRun: ${runId} failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TriggerRunStatus;
}

const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "INTERRUPTED",
  "TIMED_OUT",
]);

/**
 * Poll a run to a terminal status. Not realtime (that's the `x-trigger-jwt`
 * subscription from the trigger response, browser-side) — a plain interval
 * poll, adequate for a script/adapter waiting on one job.
 */
export async function pollTriggerRun(
  projectKeyName: string,
  runId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<TriggerRunStatus> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const run = await getTriggerRun(projectKeyName, runId);
    if (TERMINAL_STATUSES.has(run.status)) return run;
    if (Date.now() >= deadline) {
      throw new TriggerTaskError(
        `pollTriggerRun: ${runId} did not reach a terminal status within ${timeoutMs}ms (last status: ${run.status})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
