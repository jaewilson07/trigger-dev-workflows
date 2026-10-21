import { createHash } from "node:crypto";

/**
 * Run one of cubby's cron jobs over SSH (DAT-1606; runner contract: DAT-1605).
 *
 * `ssh -i <key> jaewilson07@cubby.lan <job>` hits a forced-command runner on
 * cubby that reads the job name from SSH_ORIGINAL_COMMAND. Exit 0 = OK,
 * exit 2 = job name rejected, anything else = the job's own failure.
 *
 * This module is transport-agnostic: the real `ssh2` transport lives in
 * `cubbyRunJobSsh2.ts`, tests inject a fake. Never log the private key.
 */

export const CUBBY_HOST = "cubby.lan";
export const CUBBY_USER = "jaewilson07";
export const CONNECT_TIMEOUT_MS = 15_000;
export const OUTPUT_TAIL_LINES = 50;
export const REJECTED_EXIT_CODE = 2;

export interface SshExecRequest {
  host: string;
  username: string;
  privateKey: string;
  hostKey: string;
  command: string;
  connectTimeoutMs: number;
}

export interface SshExecResult {
  exitCode: number;
  output: string;
}

/** Runs `command` on the remote host. Rejects with a Node-style `code` on connect failure. */
export type SshTransport = (req: SshExecRequest) => Promise<SshExecResult>;

export type CubbyJobResult =
  | { status: "ok"; job: string; exitCode: 0; outputTail: string }
  | { status: "skipped"; job: string; reason: "cubby offline" };

export class CubbyConfigError extends Error {
  override name = "CubbyConfigError";
}

export class CubbyJobFailedError extends Error {
  override name = "CubbyJobFailedError";
  constructor(
    readonly job: string,
    readonly exitCode: number,
    readonly outputTail: string,
  ) {
    super(`cubby job ${job} failed with exit code ${exitCode}\n${outputTail}`);
  }
}

export class CubbyJobRejectedError extends Error {
  override name = "CubbyJobRejectedError";
  constructor(
    readonly job: string,
    readonly outputTail: string,
  ) {
    super(`cubby runner rejected job name ${job} (exit 2)\n${outputTail}`);
  }
}

export class CubbyHostKeyMismatchError extends Error {
  override name = "CubbyHostKeyMismatchError";
}

/** Thrown by a transport when the connect phase exceeds its timeout. */
export class CubbyConnectTimeoutError extends Error {
  override name = "CubbyConnectTimeoutError";
  readonly code = "ETIMEDOUT";
}

const OFFLINE_CODES = new Set([
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
]);

export function isOfflineError(err: unknown): boolean {
  if (err instanceof CubbyConnectTimeoutError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && OFFLINE_CODES.has(code);
}

export function tailLines(text: string, n = OUTPUT_TAIL_LINES): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * Does the server's raw host key (SSH wire-format blob) match the pin?
 * The pin is either an OpenSSH public key line (`ssh-ed25519 AAAA... [comment]`)
 * or a `SHA256:<base64>` fingerprint, as printed by `ssh-keygen -lf`.
 */
export function hostKeyMatches(pin: string, serverKey: Buffer): boolean {
  const p = pin.trim();
  if (p.startsWith("SHA256:")) {
    const fp = createHash("sha256").update(serverKey).digest("base64").replace(/=+$/, "");
    return fp === p.slice("SHA256:".length).replace(/=+$/, "");
  }
  const blob = p.split(/\s+/)[1];
  if (!blob) return false;
  return Buffer.from(blob, "base64").equals(serverKey);
}

export interface RunCubbyJobDeps {
  transport: SshTransport;
  env?: Record<string, string | undefined>;
  host?: string;
  username?: string;
  connectTimeoutMs?: number;
}

export async function runCubbyJob(job: string, deps: RunCubbyJobDeps): Promise<CubbyJobResult> {
  const env = deps.env ?? process.env;
  const privateKey = env.CUBBY_RUN_JOB_SSH_KEY?.trim();
  const hostKey = env.CUBBY_SSH_HOST_KEY?.trim();
  if (!privateKey) throw new CubbyConfigError("CUBBY_RUN_JOB_SSH_KEY is not set");
  if (!hostKey) throw new CubbyConfigError("CUBBY_SSH_HOST_KEY is not set (host-key verification is mandatory)");

  let res: SshExecResult;
  try {
    res = await deps.transport({
      host: deps.host ?? CUBBY_HOST,
      username: deps.username ?? CUBBY_USER,
      privateKey: privateKey.includes("\n") ? privateKey : privateKey.replace(/\\n/g, "\n"),
      hostKey,
      command: job,
      connectTimeoutMs: deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    });
  } catch (err) {
    if (isOfflineError(err)) return { status: "skipped", job, reason: "cubby offline" };
    throw err;
  }

  const outputTail = tailLines(res.output);
  if (res.exitCode === 0) return { status: "ok", job, exitCode: 0, outputTail };
  if (res.exitCode === REJECTED_EXIT_CODE) throw new CubbyJobRejectedError(job, outputTail);
  throw new CubbyJobFailedError(job, res.exitCode, outputTail);
}
