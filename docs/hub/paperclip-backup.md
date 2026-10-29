# Paperclip backup (trigger.dev schedule, cubby execution, bonker MinIO copy)

How the nightly Paperclip backup works today. Prod Paperclip runs on **cubby** (`paperclip`, `paperclip-db`
= postgres 17, volume `local-ai-stack_paperclip-data`). trigger.dev owns the schedule, run history and
alerts; the backup itself is one script on cubby; the verified copy lives on **bonker**.

```
trigger.dev (bonker)  paperclip-backup, 02:15 America/Denver
  1. presign 3 PUT URLs (bonker MinIO, scoped user)           watchdog/src/lib/s3Sigv4.ts
  2. ssh cubby `backup`  (runs the runner with SSH_ORIGINAL_COMMAND=backup; URLs on stdin)
        paperclip-backup-run -> paperclip-backup.sh           infra-cubby apps/paperclip/backup/
          pg_dump -Fc  +  tar.gz of secrets, companies, skills, data/storage (volume mounted :ro)
          restore into a throwaway postgres (paperclip-restorecheck-<stamp>-<pid>), compare issues + agents
          counts with live (>0 and >=98%), remove the container
          curl -T dump / essentials / manifest  ->  http://bonker.lan:9010/paperclip-backups/daily/<runId>/
  3. HEAD-check sizes == what cubby hashed; Sundays (Denver) copy to weekly/<runId>/
  4. retention: newest 14 daily + 8 weekly; only runs after 1-3 succeeded
  failure at any step -> Slack (#datacrew-ai) + failed run (failureAlertReport also files an issue)
paperclip-backup-freshness, 08:30: newest COMPLETE daily run in MinIO older than 26h (or none) -> Slack.
```

## Where things are

| What | Where |
|---|---|
| Offsite copies | bonker MinIO `bonker.lan:9010`, bucket `paperclip-backups`: `daily/<runId>/{paperclip.dump,paperclip-essentials.tar.gz,manifest.json}`, same under `weekly/`. runId = UTC `YYYYMMDDTHHMMSSZ`. |
| On cubby (7 days) | `~/paperclip-host/backups/paperclip_<stamp>.dump`, `paperclip-essentials_<stamp>.tar.gz` |
| Last run on cubby | `~/.local/state/paperclip-backup/last-run.json` |
| Secrets (Infisical, project homeserver, prod, path `/infrastructure`; existing entries, nothing minted for this) | `CUBBY_SSH_PRIVATE_KEY`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`. The cubby host key is public and pinned in `paperclipBackup.ts`. |
| Essentials tarball content | `instances/default/{secrets,companies,skills,data/storage}` of the data volume (~250 MB; the 65 GB of caches and checkouts is regenerable and excluded) |

cubby never holds MinIO credentials: it can only PUT to the three presigned URLs (valid 1 h), and the runner
rejects any URL not starting with `http://bonker.lan:9010/`. The SSH key can run `backup` or `status` and
nothing else (`restrict`, `from=192.168.1.158`).

## Run it by hand (test)

```bash
# 1. forced command alone, no upload (safe: prod is only read; takes ~2-6 min, writes to cubby's backup dir)
ssh -i <key> jaewilson07@cubby.lan backup </dev/null
ssh -i <key> jaewilson07@cubby.lan status
ssh -i <key> jaewilson07@cubby.lan id        # must exit 2: rejected
# 2. the full pipeline: dashboard https://triggers.datacrew.space -> watchdog -> paperclip-backup -> Test
```

## Restore

```bash
# fetch (any machine with mc or curl + a presigned GET; or on bonker with the MinIO user)
mc alias set pcbk http://bonker.lan:9010 <access> <secret>
mc cp pcbk/paperclip-backups/daily/<runId>/paperclip.dump .
mc cp pcbk/paperclip-backups/daily/<runId>/paperclip-essentials.tar.gz .
# database: into a SCRATCH postgres first (never a prod name), inspect, then into paperclip-db if truly restoring
docker run -d --name pc-restore-scratch -e POSTGRES_PASSWORD=x postgres:17-alpine
docker exec pc-restore-scratch createdb -U postgres paperclip
docker exec -i pc-restore-scratch pg_restore -U postgres -d paperclip --no-owner --no-acl --exit-on-error < paperclip.dump
# files: extract into a scratch dir, inspect, then copy into the data volume with paperclip STOPPED
mkdir scratch && tar xzf paperclip-essentials.tar.gz -C scratch
```
For a real restore into cubby: stop `paperclip`, restore into `paperclip-db` (drop/recreate the `paperclip`
database first), restore the files, start `paperclip`, check `/api/health`.

## When it alerts

| Message | Meaning / first move |
|---|---|
| `cubby unreachable ... backup NOT taken` | cubby down or ssh blocked. Offline is a failure here (unlike cubbyJobs.ts, which skips). |
| `exit 3 (RESTORE CHECK FAILED)` | the dump did not restore or counts disagree. The dump stays on cubby for inspection and is NOT uploaded. Do not trust last night's data until re-run. |
| `exit 4` / `size != cubby` | upload to MinIO failed or truncated; check bonker disk and MinIO health. |
| `exit 5` | a backup is already running on cubby (manual run overlapping). |
| `STALE or unverifiable` | no complete offsite run younger than 26 h: the nightly task did not run or failed before upload. |

## Rules

- The local systemd timer in infra-cubby (`paperclip-backup.timer`) is a fallback only. Do not enable it while this task
  is scheduled (two dumps a night).
- Retention never runs after a failed night.
- One trigger.dev deploy costs ~20 GB of build cache: batch changes to this file with other watchdog changes.
