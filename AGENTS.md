# trigger-dev-workflows

DataCrew's Trigger.dev tasks, deployed to the **self-hosted** instance at
`https://triggers.datacrew.space`. Per-project agent notes live in each
subdirectory's own `AGENTS.md` (e.g. `storm-research/AGENTS.md`).

## Documentation hub

`docs/hub/` is where "how does X actually work today" explainer docs live —
see `docs/hub/README.md` for the convention and why it's a different genre
from the `docs/*-rework.md` decision records sitting next to it. When you
write up how some current mechanism works (not a decision about to be made
or just made), it goes there, not as a new top-level `docs/*.md` file.

## Project boundaries

Three deployed projects, two domains — see `docs/ADR-001-project-boundaries.md`
for the full reasoning:

- **`watchdog`** — infrastructure triggers. Keeps the house's own systems
  honest (health/service/repo-config drift, repo monitoring, cron
  data-pipeline jobs like `crew-rag-domo-scrape`). No human is a first-class
  participant in the run.
- **`executive-assistant`** — every workflow that exists to serve the
  assistant, the Slack bots, or the website (email digest, morning brief,
  Pattern Hunter, report/brief delivery). **`storm-research` belongs to this
  domain too**, even though it deploys as its own separate Trigger.dev
  project with its own secret key — domain and deploy boundary are different
  axes.
- **`packages/shared`** is neither — cross-cutting infrastructure (Infisical
  helpers, the git+uv build extension) both domains depend on.

New task: does it exist to tell a human something about the
assistant/Slack/website, or to keep some other system correct regardless of
whether a human is watching? The former is executive-assistant-domain, the
latter is watchdog.

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

- **FIXED (2026-08-07, `infra-bonker@ee5cdd0`) — the Bearer bypass used to be
  an ALLOWLIST of one specific key, not "any valid Bearer".** Previously the
  gate string-compared the presented key against a single configured
  `TRIGGER_SECRET_KEY` env var, which only ever held `executive-assistant`'s
  key — so `storm-research` and `watchdog` got `403
  {"detail":"missing Turnstile token"}` on any `triggerAndWait` (their
  `batch.triggerByTaskAndWait` fan-outs were unaffected, since
  `POST /api/v1/tasks/batch` was never matched by the gate rule at all). Fixed
  by validating the presented key **live against `GET /api/v1/whoami`** on
  `trigger-webapp-1` instead of comparing against one hardcoded value — any
  current or future project's real secret key now clears the gate with
  nothing to update here, and Trigger.dev's own auth still rejects a bad key
  regardless of what this gate decides. Verified live: `watchdog`'s (corrected)
  key now returns `200` on `POST /api/v1/tasks/*/trigger`. See
  `docs/storm-research-rework.md`/`docs/watchdog-rework.md` for the original
  diagnosis and `homeserver/services/auth/gate_router.py`'s own docstring for
  the fixed implementation.

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
