---
name: trigger-project-credentials
description: "Source and manage the per-project API secret keys used to trigger Trigger.dev tasks programmatically (POST /api/v1/tasks/{id}/trigger) — where they live in Infisical, how to fetch one safely, and how to set one up correctly for a brand-new project so it doesn't end up with a placeholder key nobody ever replaced. Use for: \"trigger secret key\", \"how do I trigger a trigger.dev task from a script\", \"TRIGGER_SECRET_KEY\", \"WATCHDOG_TRIGGER_SECRET_KEY\", \"new trigger.dev project has no credentials\", \"storm-research won't trigger\", \"trigger API 401\"."
metadata:
  version: 1.1.0
  created: 2026-08-09
  updated: 2026-09-13
---

# Trigger.dev project credentials

Covers the **per-project API secret key** used to call
`POST /api/v1/tasks/{id}/trigger` and friends against
`https://triggers.datacrew.space` — a different credential from the one
`deploy-trigger-tasks` covers.

| Credential | Prefix | Scope | Used for | Skill |
|---|---|---|---|---|
| Environment secret key | `tr_prod_…` / `tr_dev_…` / `tr_stg_…` / `tr_preview_…` | one project, one environment | **triggering tasks via the REST API** (this skill) | here |
| Personal access token (PAT) | `tr_pat_…` | one user, across orgs | **deploying** (`trigger.dev deploy`) | `deploy-trigger-tasks` |

A PAT does not work for triggering — the trigger endpoint is secret-key-only.
Full token-type/validation-path detail:
[`trigger-dev-workflows/docs/hub/trigger-dev-auth.md`](https://github.com/jaewilson07/trigger-dev-workflows/blob/main/docs/hub/trigger-dev-auth.md)
— this skill is the narrower, actionable half of that explainer:
where the key actually lives and how to fetch/set it.

## The convention

Every project's real PROD environment secret key is copied into Infisical
once, at project-creation time, and read from there by anything that needs
to trigger a task — a script, a cron, another Trigger.dev task calling a
sibling project.

- **Infisical project**: `3fbb4296-d4e6-4c17-83ee-b852a57a5e50`
- **Path**: `/trigger`
- **Infisical environment**: `prod` (this is Infisical's own environment
  slug for the shared org project — unrelated to which Trigger.dev
  environment the key authenticates to; every key stored here is that
  project's **Trigger.dev prod** key specifically. There is no convention
  yet for storing dev/stg/preview keys in Infisical — those are used
  interactively via `trigger dev`/preview deploys, not fetched by scripts.)
- **Key naming**: `<PROJECT_NAME_UPPER_SNAKE>_TRIGGER_SECRET_KEY`, e.g.
  `WATCHDOG_TRIGGER_SECRET_KEY` for the `watchdog` project.

**One legacy exception, worth knowing so it doesn't look like a mistake:**
`executive-assistant` — the first project created — has its key stored
under the bare, unprefixed name `TRIGGER_SECRET_KEY`, not
`EXECUTIVE_ASSISTANT_TRIGGER_SECRET_KEY`. When looking one up, try the
prefixed name first and fall back to the bare name only for
`executive-assistant`. Every project created since has used the prefixed
form — keep doing that; the bare name is not a pattern to repeat.

Verified by comparing prefixes between Infisical and Trigger.dev's own
Postgres (`docker exec trigger-postgres-1 psql -U postgres -d main -tAc
'select p.name, re.slug, left(re."apiKey",12) from "Project" p join
"RuntimeEnvironment" re on re."projectId"=p.id;'` on bonker):
`WATCHDOG_TRIGGER_SECRET_KEY` = `tr_prod_8q09…` = watchdog's real DB key;
`TRIGGER_SECRET_KEY` = `tr_prod_E6OW…` = executive-assistant's real DB key.

## Fetching a key / triggering a task

**From TypeScript (Trigger.dev workflows, a Letta channel adapter, any Node
caller):** call the real function, don't re-derive the Infisical/curl dance —
```ts
import { triggerTaskDotDevTask, pollTriggerRun } from "@datacrew/trigger-shared";

const { id: runId } = await triggerTaskDotDevTask(
  "watchdog",              // projectKeyName -> WATCHDOG_TRIGGER_SECRET_KEY
  "hello-observability",   // taskId
  { message: "hi" },       // payload
  "a-stable-idempotency-key"
);
const run = await pollTriggerRun("watchdog", runId);
```
This handles the `--recursive` Infisical lookup (empirically required —
`/trigger`'s secrets are invisible to a non-recursive `get` at that exact
path) and the `executive-assistant` bare-name legacy fallback internally —
see `trigger-dev-workflows/packages/shared/src/trigger-task.ts`.

**No TS runtime available (bare shell/CI):** the bash procedure this
function replaces is preserved for reference in that same file's git
history — reach for the TS function above wherever Node is available before
falling back to hand-rolling the Infisical CLI + curl calls.

Full request/response shapes, the "unknown task id still returns 200"
gotcha, and idempotency-key guidance:
[`trigger-dev-workflows/docs/hub/trigger-dev-auth.md`](https://github.com/jaewilson07/trigger-dev-workflows/blob/main/docs/hub/trigger-dev-auth.md).

## Setting up a NEW project's credentials

A project scaffolded without this checklist can end up with literal
placeholder keys in every environment (e.g. `tr_prod_test123`, 14–18
characters, obviously not Trigger.dev-generated) and nothing in Infisical —
never triggerable via the API. Before step 1, **check whether the new task
actually needs its own project at all** — most don't (`storm-research` was
folded into `executive-assistant` for this reason, `docs/ADR-001-project-boundaries.md` in this repo). Follow this
checklist when it genuinely does.

1. **Create the project via the dashboard**
   (`https://triggers.datacrew.space`), not the CLI scaffold — creating it
   there is what generates real per-environment keys. A CLI-scaffolded
   project can leave placeholder/empty values that look configured but
   aren't.
2. **Confirm the prod key is real**, not a placeholder, before trusting it:
   ```bash
   ssh bonker "docker exec trigger-postgres-1 psql -U postgres -d main -tAc \
     'select re.slug, length(re.\"apiKey\"), left(re.\"apiKey\",12) from \"Project\" p \
      join \"RuntimeEnvironment\" re on re.\"projectId\"=p.id where p.name='\''<project>'\'';'"
   ```
   A real key is `tr_<envslug>_` followed by ~20 random characters — roughly
   27–31 characters total. Short (~14–18 chars) or containing an obviously
   fake string (`test`, `123`) means it was never really issued.
3. **Store it in Infisical**, following the naming convention above:
   ```bash
   infisical secrets set <PROJECT>_TRIGGER_SECRET_KEY="<the real tr_prod_… value>" \
     --projectId 3fbb4296-d4e6-4c17-83ee-b852a57a5e50 --path /trigger --env prod \
     --token "$(cat /tmp/.itoken)" --domain "https://infisical.datacrew.space/api"
   ```
   `infisical secrets set` echoes the value it just wrote to stdout — redirect
   output, don't let it land in a log (see the CLI-secrets-echo gotcha in
   general Infisical guidance).
4. **Verify with a real smoke trigger** — fetch the key back out of
   Infisical (not the value you just typed — prove the round-trip), and
   `POST /api/v1/tasks/{any-real-task-id}/trigger` against it. A `200` with
   a run id confirms the whole chain works; don't stop at "the CLI didn't
   error."

## Detecting the gap on an existing project

Compare every environment's key length/prefix in Postgres (query above,
drop the `where` clause to see all projects) against what Infisical has
under `/trigger`. A project with no matching `<PROJECT>_TRIGGER_SECRET_KEY`
entry, or whose DB key looks like a placeholder per step 2 above, has never
actually been triggerable via the API — regardless of how many tasks it has
successfully deployed. Deploying and triggering are unrelated capabilities;
a project can do the first perfectly and have never been able to do the
second.

## Never hardcode a real key value in a committed file

Point to Infisical, always — `<PROJECT>_TRIGGER_SECRET_KEY` at
`/trigger`, not a literal `tr_prod_…` string. `trigger-dev-workflows` is a
**public** repo, and a real production key has already been committed to it in
plaintext once. If a doc needs to show what a key looks like, use an obviously
fake placeholder (`tr_prod_XXXXXXXXXXXXXXXXXXXX`) — never a real value, not
even in investigation notes.

## Related Skills

- `deploy-trigger-tasks` — the companion credential (`TRIGGER_PAT`), and
  the bonker-only deploy constraint (umbrella ADR-046, archived umbrella jaewilson07/simpleDiscordBot@3b0775e28).
