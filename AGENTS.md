# trigger-dev-workflows

DataCrew's Trigger.dev tasks, deployed to the **self-hosted** instance at
`https://triggers.datacrew.space`. Per-project agent notes live in each
subdirectory's own `AGENTS.md` (e.g. `storm-research/AGENTS.md`).

## Invoking these tasks from outside (authentication)

How an external service — the DataCrew Slack bots (`datacrew/slackbot`), or any
`/datacrew` caller — authenticates to trigger a task here.

**Use the project Secret API key as a Bearer token. Nothing else.**

- **Key:** the self-hosted project's **prod secret key** (`tr_prod_…`), stored in
  Infisical at **`/trigger` → `TRIGGER_SECRET_KEY`** (verified 2026-08). This is
  the server-side secret key — *not* a personal access token (`tr_pat_…`) and
  *not* the frontend's one-time public trigger token. It can trigger any task and
  read runs, so keep it in Infisical, inject at deploy, never commit it.
- **Request:**

  ```
  POST https://triggers.datacrew.space/api/v1/tasks/{taskIdentifier}/trigger
  Authorization: Bearer $TRIGGER_SECRET_KEY
  Content-Type: application/json
  User-Agent: <your service name>          # see the WAF gotcha below

  { "payload": { … }, "options": { "tags": ["slack", "<user>"] } }
  ```

  Base URL is configurable via `TRIGGER_API_URL` (default
  `https://triggers.datacrew.space`).

- **The Bearer token bypasses the Turnstile bot-gate — do not try to solve
  Turnstile from a bot.** `triggers.datacrew.space` sits behind a shared bot-gate
  (`homeserver/services/auth/gate_router.py`) that forces a Turnstile challenge on
  **browser** callers of `POST /api/v1/tasks/*/trigger`. Callers presenting an
  `Authorization: Bearer …` header on `/api/*` are exempt by design (the Caddy
  `/api/* + Bearer` bypass rule) — so a server-side caller with the secret key
  goes straight through and never sees Turnstile.

- **Gotcha — send a real `User-Agent`, or you get a 403 that looks like an auth
  failure but isn't.** Cloudflare's browser-integrity WAF in front of the host
  returns **`403` / `error code: 1010`** to requests whose User-Agent looks like a
  bot library (confirmed live with the default `Python-urllib/*`; a conventional
  UA returns `200`). Set an explicit `User-Agent` header (your service name, or
  something like `curl/8.5.0`). This rejection happens at the edge, **before**
  Trigger.dev is reached, so the error mentions nothing about tokens or tasks.

- **KNOWN BREAKAGE (2026-08-05) — the Bearer bypass is an ALLOWLIST of specific
  keys, not "any valid Bearer".** The bullet above says a server-side caller with
  a project secret key goes straight through. That is true only for the
  `executive-assistant` prod key. Measured against the public URL, same path,
  same User-Agent, every task identifier:

  | Key | `POST /api/v1/tasks/*/trigger` |
  | --- | --- |
  | `executive-assistant` prod | `200` |
  | `storm-research` prod | `403 {"detail":"missing Turnstile token"}` |
  | `watchdog` prod | `403 {"detail":"missing Turnstile token"}` |

  `POST /api/v1/tasks/batch` is not matched by the gate rule and reaches
  Trigger.dev's own auth regardless of key.

  This is not cosmetic: a run's `triggerAndWait` calls the gated endpoint with
  its own project's key, so **tasks in `storm-research` and `watchdog` cannot
  trigger child tasks at all**, while their `batch.triggerByTaskAndWait` fan-outs
  work fine. Fix in `homeserver/services/auth/gate_router.py` — either allowlist
  those two keys, or make the Bearer exemption unconditional and let Trigger.dev
  reject bad keys. See `docs/storm-research-rework.md` for the full diagnosis.

## Composition conventions

The repo-wide pattern, established by the morning-brief rework
(`executive-assistant/docs/morning-brief-rework.md`) and extended to every other
workflow on 2026-08-05 (`docs/*-rework.md`):

1. A **schedule/entry point** that does nothing but sequence.
2. A **research workflow** producing a structured payload, knowing no destination.
3. One **typed seam** between the halves — structured data, *not* rendered output,
   so a destination needing a different format is a new task rather than an edit.
4. A **delivery workflow** that renders once and fans out to N interchangeable
   destination tasks in parallel via `batch.triggerByTaskAndWait` (NOT
   `Promise.all`, which is unsupported around `triggerAndWait` and does not
   isolate failures).

**Status vocabulary — `delivered | skipped | failed`, repo-wide.** `skipped` is a
RESULT, not an error: an unconfigured destination is the normal state of a fresh
checkout, and encoding it as a failure makes "nobody configured Slack"
indistinguishable from "Slack returned a 500". Only a genuine failure throws, where
Trigger.dev's retry applies; the delivery orchestrator records the final failure
without taking down its siblings. Declared per project — `lib/brief-delivery.ts`
and `lib/report-delivery.ts` (executive-assistant), `lib/storm-types.ts`
(storm-research), `src/lib/infra-delivery.ts` (watchdog) — because the three
projects have separate `package.json`/`trigger.config.ts` files and deploy
independently. Sharing them needs a real shared package; the identical vocabulary
is what that package would formalize.

**Fan-out batches are fixed-length.** `triggerByTaskAndWait` types its results
positionally, so a conditionally-shortened array loses per-destination types. Always
trigger every destination and let an unconfigured or caller-disabled one return
`skipped` — the run history then also records which destinations were live each day.

### Reference implementation

`datacrew/slackbot/commands/email_summary.py` → `_trigger_summarize_inbox()`:
the `/email-summary` slash command POSTs to
`/api/v1/tasks/email-digest/trigger` with `Authorization: Bearer
$TRIGGER_SECRET_KEY`. That is the canonical pattern — copy it. (It uses `httpx`,
whose default `python-httpx/*` User-Agent may also trip the WAF; set an explicit
`User-Agent` header there.)

### Environments

`tr_prod_…` triggers against the **prod** deploy; dev has its own key. Bots
invoking deployed tasks use the prod secret key from Infisical `/trigger`.
Rotating it means updating Infisical `/trigger` **and** every consumer's injected
env — there is no live reload.
