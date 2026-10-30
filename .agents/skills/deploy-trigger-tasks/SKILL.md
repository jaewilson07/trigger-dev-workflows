---
name: deploy-trigger-tasks
description: "Deploy Trigger.dev tasks to the self-hosted instance at triggers.datacrew.space, and diagnose runs that never start. Covers the bonker-only constraint, CLI version pinning, preview branches, verifying a deploy actually landed, and the QUEUED-forever failure mode that produces no alert. Use for: \"deploy the trigger tasks\", \"deploy executive-assistant/watchdog/storm-research\", \"runs are stuck queued\", \"morning brief didn't run\", \"trigger deploy failed\", \"preview branch deploy\"."
metadata:
  version: 1.0.0
  created: 2026-08-07
---

# Deploying Trigger.dev tasks

Self-hosted instance: `https://triggers.datacrew.space` (v4.5.7, on bonker).
Decision record: umbrella ADR-046
(`.agents/adrs/ADR-046-trigger-deploys-originate-where-the-worker-can-pull.md` in the archived umbrella jaewilson07/simpleDiscordBot@3b0775e28).

## The one thing to know

**The CLI builds the image locally and pushes to `DEPLOY_REGISTRY_HOST`, which
on this instance is `localhost:5000` — bound to loopback on bonker.** So the
deploy host *is* the delivery mechanism. Deploy on bonker and the supervisor
finds the image in the same docker daemon. Deploy anywhere else and the image
is stranded, the deploy still reports success, and every subsequent run queues
forever without ever failing.

That is not hypothetical: it took the daily brief down for ~24h on 2026-08-06.

## Deploy

One script, run on bonker — same shape and name as every other service here
(cf. `~/GitHub/mdrag/scripts/deploy-bonker.sh`). Deploys are manual by design: bonker
is LAN-only with no public IP a hosted runner can reach, and there is no
self-hosted runner in the fleet.

```bash
# TRIGGER_PAT from Infisical project 3fbb4296-…, path /trigger
ssh bonker "TRIGGER_ACCESS_TOKEN='<TRIGGER_PAT>' \
  bash ~/GitHub/trigger-dev-workflows/scripts/deploy-bonker.sh executive-assistant"
```

The script pulls, runs the preflight, pins the CLI to the project's own SDK
version, deploys, and **verifies the image actually landed on this host's
daemon** — the check that would have caught the 2026-08-06 outage.

Projects: `executive-assistant` | `watchdog` | `indb-blues` (in-repo, what `all`
deploys), plus the external projects in `scripts/external-projects.conf`
(`rss-feed-factory`; never part of `all`).

| Project | `TRIGGER_PROJECT_REF` | Code lives in |
|---|---|---|
| executive-assistant | `proj_noaaludkbpoorzosejyn` | this repo |
| watchdog | `proj_wxqgcxxcutibtcgxlzky` | this repo |
| indb-blues | `proj_vbdokvsqejsehxoztzmm` | this repo |
| rss-feed-factory | `proj_ixggjonbwujajputfcvh` | `jaewilson07/rss-feed-factory` (config in `jaewilson07/infra-cubby` `apps/rss-feed-factory/`) |

### Deploying an external project (rss-feed-factory)

```bash
bash scripts/deploy-bonker.sh rss-feed-factory   # forwards over ssh when off bonker
```

Same script, same guards (preflight, CLI pinned to the project's SDK, machine-identity
`syncEnvVars()`, `WorkerDeployment` image-landed check, registry push). What differs:
it builds from deploy-only worktrees under `~/deploy` (code repo at `origin/<code ref>`,
infra-cubby at `origin/main`), copies `<config-subdir>/feeds.yaml` into the code root,
reinstalls only when `package-lock.json` changed, and runs `npm run validate:registry`
first. A bad registry aborts before any build. Both commit SHAs are logged.

A Feed Registry change is a **redeploy**: `feeds.yaml` ships via `additionalFiles`,
so merge it to infra-cubby `main`, then run the command above. Runtime fetch was
rejected (ADR-033 addendum, 2026-10-30).

To add another external project, add one line to `scripts/external-projects.conf`
(name, ref, code URL, code ref, config URL, config subdir). An empty ref fails early.

`storm-research` (`proj_wirdhbubjmhwu4r`) is retired — folded into
`executive-assistant` 2026-08-12 (`trigger-dev-workflows` PR #47). STORM
tasks deploy as part of `executive-assistant` now; there's no third project.

Refs verified against the database on 2026-08-07:

```bash
ssh bonker "docker exec trigger-postgres-1 psql -U postgres -d main \
  -tAc 'select name, \"externalRef\" from \"Project\" order by name;'"
```

### Always verify — success does not mean deployable

`trigger deploy` confirms it built and registered. It never checks that the
worker can pull the result. Confirm the artifact exists:

```bash
ssh bonker "docker images --format '{{.Tag}}' localhost:5000/trigger/<PROJECT_REF> | sort | tail -1"
```

That tag must match the version the deploy printed. If it doesn't, the deploy
is a no-op that will queue every future run.

## Preview branches

Supported (verified on v4.5.7). The push-to-deploy **GitHub App is not** —
self-hosted has no `GITHUB_*` config surface, only OAuth login vars.

```bash
npx --yes trigger.dev@<sdk-version> deploy --env preview --branch my-branch
npx --yes trigger.dev@<sdk-version> preview archive --branch my-branch
```

Pass `--branch` explicitly in CI: `actions/checkout` leaves a detached HEAD, so
the CLI's git auto-detection is unreliable there.

## Diagnosing "runs are stuck / the daily didn't run"

A stranded image produces **one of two signatures**, and which one you get
depends on the engine version:

- **Queues forever** — flips `QUEUED ↔ EXECUTING` at `attemptCount: 0`. Nothing
  failure-based can alert on it. This is what caused the 2026-08-06 outage.
- **Fails after ~1h** — `SYSTEM_FAILURE` with
  `TASK_RUN_DEQUEUED_MAX_RETRIES: "Trying to create an attempt failed multiple
  times"`. Observed 2026-08-07/08 on v4.5.7.

The second is the same fault with a terminal state bolted on, so **treat a
`SYSTEM_FAILURE` carrying that code as a stranded image, not as a task bug.**
The tell in both cases is `attemptNumber = null` — the run was dequeued
repeatedly and no attempt was ever created, so no task code ever executed.

```bash
# 1. Is anything stuck? (also what the dead-man's switch checks)
cd ~/GitHub/trigger-dev-workflows
TRIGGER_SECRET_KEY=… TRIGGER_API_URL=https://triggers.datacrew.space \
  node scripts/trigger-deadman.mjs --dry-run --task=morning-brief

# 2. Which version did the run want, and did an attempt ever start?
ssh bonker "docker exec trigger-postgres-1 psql -U postgres -d main -xc \
  'select tr.\"friendlyId\", tr.status, tr.\"attemptNumber\", bw.version
     from \"TaskRun\" tr
     left join \"BackgroundWorker\" bw on bw.id = tr.\"lockedToVersionId\"
    where tr.status = '\''SYSTEM_FAILURE'\'' order by tr.\"createdAt\" desc limit 5;'"

# 3. Is THAT version's image on bonker? (compare against the deployment record)
ssh bonker "docker exec trigger-postgres-1 psql -U postgres -d main -tAc \
  'select \"imageReference\" from \"WorkerDeployment\" where version = '\''<VERSION>'\'';'"
ssh bonker "docker image inspect <imageReference-without-@sha256:...> >/dev/null 2>&1 \
  && echo CACHED || echo MISSING"
```

`MISSING` confirms it: the deploy came from the wrong host. **Fix: redeploy from
bonker.**

> **`docker logs trigger-supervisor-1` is not a diagnostic here.** The container
> runs with the `local` log driver and, on a long-lived container, `docker logs`
> has returned *nothing at all* (verified 2026-08-09, container up since
> 2026-07-29). An earlier version of this skill told you to grep it for
> `no such image`; that silently returns empty and reads like "no problem found."
> Use the execution snapshots instead — they record the state machine directly:
>
> ```bash
> ssh bonker "docker exec trigger-postgres-1 psql -U postgres -d main -tAc \
>   'select \"createdAt\", \"executionStatus\", description
>      from \"TaskRunExecutionSnapshot\"
>     where \"runId\" = (select id from \"TaskRun\" where \"friendlyId\" = '\''<RUN_ID>'\'')
>     order by \"createdAt\";'"
> ```
>
> A stranded image looks like `PENDING_EXECUTING` → exactly 60s → `QUEUED`
> ("Requeued the run after a failure"), repeating with widening backoff. The run
> never reaches `EXECUTING`.
**Fix: redeploy from bonker.** Then cancel the stuck runs — they will not
recover on their own:

```bash
curl -s -X POST "https://triggers.datacrew.space/api/v2/runs/<RUN_ID>/cancel" \
  -H "Authorization: Bearer $TRIGGER_SECRET_KEY"
```

## A task that fails at `TASK_OUTPUT_ERROR` is object storage, not the task

Different fault from the stranded image above, and the message misdirects just as
badly — it names the task and never names MinIO:

```
TASK_OUTPUT_ERROR / SubtaskUnwrapError
  TriggerApiError: 403 InvalidAccessKeyId
  Key: <PROJECT_REF>/prod/<run>/output.json   BucketName: packets
```

Trigger offloads task outputs above a size threshold to MinIO's `packets` bucket, so
this hits **only tasks with large outputs** — the rest of the project looks healthy.
`attemptNumber` is 1 (the run executed), which is what separates it from a stranded
image. Two things to check:

1. **Credentials.** They must equal `trigger-minio-1`'s `MINIO_ROOT_USER` /
   `MINIO_ROOT_PASSWORD` — that instance has no IAM users and no service accounts, so
   root is the only credential that authenticates. Canonical values are in Infisical
   (`3fbb4296…`, env `dev`, path `/trigger`) as `OBJECT_STORE_ACCESS_KEY_ID` /
   `OBJECT_STORE_SECRET_ACCESS_KEY`.
2. **Endpoint.** Pin it to the **container name**, never the bare `minio` alias.
   `trigger-webapp-1` is attached to `ai-network` as well as the stack's own `webapp`
   network, and both have a host answering to `minio` — `trigger-minio-1` on one, the
   unrelated standalone `minio` container on the other. Resolution across two networks
   is not guaranteed.

```bash
# Did anything ever actually land? An empty bucket is the tell.
ssh bonker 'docker exec trigger-minio-1 mc --no-color du local/packets'
```

> **The live stack composes from a vendored upstream clone**, not from the infra repo:
> `~/GitHub/trigger.dev/hosting/docker/webapp/` on bonker. Fix `.env` there (back it up
> first) and `docker compose up -d webapp`, then reconcile the non-secret half into
> `~/GitHub/infra-bonker/apps/trigger-dev/.env.example`. Verify by confirming a real
> run's `output.json` appears in the bucket — a green run alone doesn't prove it, since
> small-output tasks never touch object storage. Fixed 2026-08-14, infra-bonker#478.

## Monitoring

`trigger-dev-workflows/scripts/trigger-deadman.mjs` runs from a systemd **user** timer on cubby every
30 min — deliberately not bonker, because a monitor on the monitored host dies
with it. That is exactly why the outage was silent: `watchdog/` posts infra
health to Slack but runs *as a Trigger.dev task*.

```bash
systemctl --user status trigger-deadman.timer     # on cubby
journalctl --user -u trigger-deadman.service -n 30
```

Config: `~/.config/trigger-deadman.env` (mode 600). Watched tasks are an
allowlist in the unit's `--task=` flag — **add new critical tasks there or they
are unmonitored.** A project key only sees its own project's runs, so each extra
project is its own timer/invocation with `--key-env=<VAR>`. rss-feed-factory's
weekly Sweep (cron `0 21 * * 4`) needs:

```bash
node scripts/trigger-deadman.mjs --task=weekly-sweep --max-age-hours=200 \
  --freshness-window-days=14 --key-env=TRIGGER_SECRET_KEY_RSS_FEED_FACTORY
```

with that project's prod secret key in `~/.config/trigger-deadman.env`. Without it a
stranded rss-feed-factory image is silent. `npm run test:deadman` covers this.

## Environment variables live in the dashboard, not `syncEnvVars`

Each project's `trigger.config.ts` has a `SYNCED_SECRETS` list that pulls from
Infisical at **build** time — but it is not where most values come from, and it
is not the list to reach for first. `executive-assistant` syncs two keys while
running with seventeen; the other fifteen are set per-project, per-environment
in the Trigger.dev dashboard and injected at **run** time.

Practical consequence: **adding a variable needs no redeploy.** Set it and the
next run sees it. Conversely, adding a name to `SYNCED_SECRETS` makes the deploy
*hard-fail* if Infisical lacks it (the config throws on `missing.length > 0`),
so only put genuinely build-time-required secrets there.

Read what a project actually has:

```bash
curl -s "https://triggers.datacrew.space/api/v1/projects/<REF>/envvars/prod" \
  -H "Authorization: Bearer $TRIGGER_PAT"     # TRIGGER_PAT from Infisical, /trigger
```

Write one (`POST` the same URL, body `{"name":…,"value":…}`). Both verified
2026-08-07 wiring `NOTION_TOKEN` + `NOTION_DATABASE_ID` into storm-research.

Notion targets differ by project and that is deliberate — `executive-assistant`
writes briefs to the **Docs** database, `watchdog` writes infra reports to its
own. Databases name their title property differently (`Title`, `Page`, `Name`),
so nothing hardcodes it: `titlePropertyName()` reads the schema and finds the
one property whose *type* is `title`.

That resolver lives in **`packages/shared/src/notion.ts`**, published to both
projects as the `@datacrew/trigger-shared` npm workspace (#69). Each project
used to carry its own `src/lib/notion.ts` copy and they had already drifted.
Fix Notion behaviour in the shared package — a per-project copy will be
overwritten. Both projects still deploy separately, so a shared-package change
needs **both** `npm run deploy:*` runs from bonker to reach production.

## Triggering through the public hostname

Works, with the project's own **secret** key — no Turnstile token:

```bash
curl -s -X POST "https://triggers.datacrew.space/api/v1/tasks/<TASK_ID>/trigger" \
  -H "Authorization: Bearer <PROJECT_PROD_KEY>" \
  -H "Content-Type: application/json" --data @body.json
```

The per-project prod key is **not** Infisical's `TRIGGER_SECRET_KEY` — that one
is `executive-assistant`'s. Get the right one from `RuntimeEnvironment.apiKey`
joined on the project ref:

```bash
ssh bonker "docker exec trigger-postgres-1 psql -U postgres -d main -tAc \
  'select p.name, re.\"apiKey\" from \"RuntimeEnvironment\" re
     join \"Project\" p on p.id = re.\"projectId\" where re.type = '\''PRODUCTION'\'';'"
```

`POST /api/v1/tasks/*/trigger` is the one path behind a bot-gate
(`services/auth/gate_router.py` in `infra-bonker`, via Caddy `forward_auth`).
It validates whatever you present against Trigger.dev's `GET /api/v1/whoami`,
which accepts **only** secret keys — `allowPublicKey`/`allowJWT` default false,
so the minted public JWTs browsers hold are rejected there and must solve
Turnstile plus a 5/hour per-IP limit. A real secret key skips both.

Until 2026-08-07 the gate string-compared one configured `TRIGGER_SECRET_KEY`,
so only `executive-assistant` was exempt and every other project got
`403 {"detail":"missing Turnstile token"}` with no way to comply. If that
symptom returns, check the gate is still validating live rather than against a
single value.

Debugging the gate — it logs every decision, keyed by a credential fingerprint,
never the key:

```bash
ssh bonker "docker logs --tail 50 auth 2>&1 | grep trigger_gate"
```

`{"detail": …}` is FastAPI's error shape; Trigger.dev uses `{"error": …}` — a
quick way to tell which layer rejected you.

## Gotchas

| Symptom | Cause |
|---|---|
| `sh: 1: trigger.dev: not found` | Bare binary, not a devDependency. Scripts now use `npx --yes trigger.dev@<sdk>`. |
| `Version mismatch detected while running in CI. Aborting.` | CLI outpaced the SDK. Pin to the project's own `@trigger.dev/sdk` version, never `@latest`. |
| `No route matches URL "/api/v1/projects//prod"` (note `//`) | `TRIGGER_PROJECT_REF` unset — `trigger.config.ts` falls back to `""`. The preflight catches this. |
| Deploy succeeds, runs still queue | Wrong host. Verify the image on bonker (above). |
| `Invalid API key` against `api.trigger.dev` | Wrong host entirely — this is self-hosted. Use `TRIGGER_API_URL=https://triggers.datacrew.space`. |
| `{"detail":"missing Turnstile token"}` on trigger | The bot-gate, not Trigger.dev. You presented a public token, not a secret key — or the gate regressed to single-secret matching (above). |
| A destination returns `skipped` in prod but works locally | Its env var is unset **in the dashboard for that project**. `SYNCED_SECRETS` is a different, build-time list. |

## Why there is no CI for this

Deliberate, and it predates the incident. mdrag's deploy script states the
constraint: bonker is LAN-only with no public IP a GitHub-hosted runner can
reach, and there is no self-hosted runner on bonker or cubby. Exposing the
registry to enable off-host deploys was tried on 2026-08-07 and reverted — it
worked on bonker, bought nothing, and added LAN surface for a capability the
fleet has decided it does not want. See umbrella ADR-046's addendum (archived umbrella jaewilson07/simpleDiscordBot@3b0775e28).

If someone proposes CI for this again, the question to answer first is why the
fleet's other services do not use it.

Upstream docs are in mdrag — `query_rag` before inferring from CLI flags.
