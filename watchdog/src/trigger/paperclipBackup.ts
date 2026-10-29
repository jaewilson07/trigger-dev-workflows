import { schedules, logger } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import {
  CONNECT_TIMEOUT_MS,
  CUBBY_HOST,
  CUBBY_USER,
  CubbyConfigError,
  CubbyHostKeyMismatchError,
  isOfflineError,
  tailLines,
  type SshTransport,
} from "../lib/cubbyRunJob.js";
import { ssh2Transport } from "../lib/cubbyRunJobSsh2.js";
import { redactSecrets } from "../lib/redactSecrets.js";
import { postSlackAlert } from "../lib/slackAlert.js";
import {
  BUCKET,
  DAILY_KEEP,
  MAX_AGE_HOURS,
  WEEKLY_KEEP,
  freshness,
  isWeeklyDay,
  objectKey,
  parseManifest,
  runId,
  selectDeletions,
  successSummary,
  type Part,
  type Tier,
} from "../lib/paperclipBackup.js";
import { copyObject, deleteObject, headSize, listAll, S3_ENDPOINT, S3_REGION } from "../lib/paperclipBackupS3.js";
import { presignUrl, type S3Creds } from "../lib/s3Sigv4.js";

/**
 * Nightly Paperclip backup (prod now runs on cubby), owned by trigger.dev: schedule, run history, Slack alerts.
 *
 *   paperclip-backup            02:15 America/Denver. ssh cubby `backup` (forced command, infra-cubby
 *                               apps/paperclip/backup/paperclip-backup-run): pg_dump, essentials tarball,
 *                               restore into a throwaway postgres + row-count check, PUT to bonker MinIO via the
 *                               presigned URLs we pass on stdin. Then we HEAD-verify sizes, copy to weekly/ on
 *                               Sundays and enforce 14 daily + 8 weekly.
 *   paperclip-backup-freshness  08:30 America/Denver. Alerts if the newest COMPLETE offsite backup is >26h old,
 *                               which also catches this task never having run.
 *
 * Secrets (Infisical /infrastructure, EXISTING entries; nothing is minted for this task): CUBBY_SSH_PRIVATE_KEY (the
 * existing bonker->cubby key) and MINIO_ACCESS_KEY / MINIO_SECRET_KEY (bonker MinIO). The cubby host key is public and
 * pinned in code (CUBBY_HOST_KEY below). cubby never sees MinIO credentials: only presigned PUT URLs for the bucket.
 * Retries are OFF: a retry would take a second dump on top of a half-finished first. Runbook: docs/hub/paperclip-backup.md
 */

const SECRET_PATH = "/infrastructure";
/** Public ed25519 host key of cubby (matches infra-cubby apps/paperclip/scripts/cubby_ssh_host_ed25519_key.pub). */
const CUBBY_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJNN6HfSLwoKN9Jdn0fabEwvkY5ctTmt+PgUvRD86Pa6";
/** Where the runner lives on cubby; override with PAPERCLIP_BACKUP_RUNNER if the checkout moves. */
const RUNNER = process.env.PAPERCLIP_BACKUP_RUNNER ?? "$HOME/GitHub/infra-cubby/apps/paperclip/backup/paperclip-backup-run";
const SSH_BACKUP_TIMEOUT_NOTE = "ssh `backup` runs dump + restore check; expect ~2-6 minutes";

async function secret(name: string): Promise<string> {
  return getSecret(name, { path: SECRET_PATH, recursive: false });
}

async function loadS3Creds(): Promise<S3Creds> {
  const [accessKey, secretKey] = await Promise.all([secret("MINIO_ACCESS_KEY"), secret("MINIO_SECRET_KEY")]);
  return { accessKey, secretKey, region: S3_REGION };
}

/** Runs one verb on cubby's forced command. Unlike cubbyJobs.ts, offline is a FAILURE here, never a skip. */
async function sshVerb(verb: "backup" | "status", stdin: string | undefined, transport: SshTransport = ssh2Transport) {
  const privateKey = await secret("CUBBY_SSH_PRIVATE_KEY");
  const hostKey = CUBBY_HOST_KEY;
  if (!privateKey) throw new CubbyConfigError("CUBBY_SSH_PRIVATE_KEY missing from Infisical /infrastructure");
  try {
    return await transport({
      host: CUBBY_HOST,
      username: CUBBY_USER,
      privateKey: privateKey.includes("\n") ? privateKey : privateKey.replace(/\\n/g, "\n"),
      hostKey,
      // The key is not pinned to a forced command, so we invoke the runner ourselves; it still accepts only these two verbs.
      command: `SSH_ORIGINAL_COMMAND=${verb} ${RUNNER}`,
      stdin,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof CubbyHostKeyMismatchError) throw err;
    if (isOfflineError(err)) throw new Error(`cubby unreachable (${(err as Error).message}); backup NOT taken`);
    throw err;
  }
}

async function alert(text: string): Promise<void> {
  try {
    await postSlackAlert(`:rotating_light: ${redactSecrets(text)}`);
  } catch (e) {
    // The run itself still fails (and failureAlertReport files an issue); never let alert plumbing mask the real error.
    logger.error("slack alert failed", { message: redactSecrets((e as Error).message) });
  }
}

export async function runBackup(now = new Date()): Promise<{ runId: string; summary: string; weekly: boolean }> {
  const s3 = await loadS3Creds();
  const id = runId(now);
  const parts: Part[] = ["dump", "essentials", "manifest"];
  const urlFor = (tier: Tier, p: Part) =>
    presignUrl(s3, { method: "PUT", endpoint: S3_ENDPOINT, path: `/${BUCKET}/${objectKey(tier, id, p)}`, expiresSeconds: 3600, now });
  const stdin = parts.map((p) => `${p}=${urlFor("daily", p)}`).join("\n") + "\n";

  logger.info("starting cubby backup", { runId: id, note: SSH_BACKUP_TIMEOUT_NOTE });
  const res = await sshVerb("backup", stdin);
  const tail = redactSecrets(tailLines(res.output));
  if (res.exitCode !== 0) {
    const why = ({ 1: "dump/tar failed", 2: "request rejected by runner", 3: "RESTORE CHECK FAILED", 4: "offsite upload failed", 5: "another backup is running" } as Record<number, string>)[res.exitCode] ?? "unknown failure";
    throw new Error(`paperclip backup ${id} failed on cubby: exit ${res.exitCode} (${why})\n${tail}`);
  }
  const manifest = parseManifest(res.output);
  if (!manifest.uploaded) throw new Error(`paperclip backup ${id}: cubby reported uploaded=false`);

  // The sizes MinIO holds must equal the sizes cubby hashed: proves the PUTs landed whole.
  const want: Record<"dump" | "essentials", number> = { dump: manifest.dump.bytes, essentials: manifest.essentials.bytes };
  for (const p of ["dump", "essentials"] as const) {
    const got = await headSize(s3, objectKey("daily", id, p));
    if (got !== want[p]) throw new Error(`offsite ${p} size ${got} != cubby ${want[p]} for ${id}`);
  }
  await headSize(s3, objectKey("daily", id, "manifest"));

  const weekly = isWeeklyDay(now);
  if (weekly) for (const p of parts) await copyObject(s3, objectKey("daily", id, p), objectKey("weekly", id, p));

  // Retention last, and only after everything above succeeded: a failed night never prunes good history.
  const keys = (await listAll(s3)).map((o) => o.key);
  for (const [tier, keep] of [["daily", DAILY_KEEP], ["weekly", WEEKLY_KEEP]] as const) {
    const doomed = selectDeletions(keys, tier, keep);
    for (const k of doomed) await deleteObject(s3, k);
    if (doomed.length) logger.info("retention pruned", { tier, objects: doomed.length });
  }
  return { runId: id, summary: successSummary(manifest, id), weekly };
}

export const paperclipBackup = schedules.task({
  id: "paperclip-backup",
  cron: { pattern: "15 2 * * *", timezone: "America/Denver", environments: ["PRODUCTION"] },
  retry: { maxAttempts: 1 },
  maxDuration: 3600,
  run: async () => {
    try {
      const r = await runBackup();
      logger.info("paperclip backup ok", r);
      return r;
    } catch (err) {
      const message = redactSecrets((err as Error).message);
      logger.error("paperclip backup failed", { message });
      await alert(`Paperclip nightly backup FAILED. ${message.slice(0, 1500)}\nRunbook: trigger-dev-workflows docs/hub/paperclip-backup.md`);
      throw err;
    }
  },
});

export const paperclipBackupFreshness = schedules.task({
  id: "paperclip-backup-freshness",
  cron: { pattern: "30 8 * * *", timezone: "America/Denver", environments: ["PRODUCTION"] },
  retry: { maxAttempts: 2 },
  maxDuration: 300,
  run: async () => {
    try {
      const s3 = await loadS3Creds();
      const f = freshness((await listAll(s3, "daily/")).map((o) => o.key), new Date());
      logger.info("paperclip backup freshness", { ...f });
      if (!f.ok) {
        throw new Error(
          f.newestRunId
            ? `newest complete offsite Paperclip backup is ${f.ageHours}h old (${f.newestRunId}); limit ${MAX_AGE_HOURS}h`
            : "no complete offsite Paperclip backup found in bonker MinIO",
        );
      }
      return f;
    } catch (err) {
      const message = redactSecrets((err as Error).message);
      await alert(`Paperclip backup STALE or unverifiable: ${message}`);
      throw err;
    }
  },
});
