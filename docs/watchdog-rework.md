# Watchdog (infra health report) composition rework

**Status:** implemented, deployed (`watchdog` 20260805.2). Both halves verified live
independently; the **entry point that sequences them is blocked by a bot-gate
misconfiguration** — root cause found, fix is one infrastructure change (see "Blocked")
**Date:** 2026-08-05
**Audit finding:** MONOLITHIC (R3) — "497 lines, one task, no child tasks, no composition of
any kind"

## The problem

`runInfrastructureHealthReport` did everything in sequence in one function: resolve a repo
root by probing hardcoded filesystem candidates, shell out to `infisical`/`letta`/`claude`/
`docker`, fetch latest versions from GitHub/npm/PyPI, fetch a Slack token from Infisical over
raw HTTP, render text + Block Kit, and post to Slack.

Every axis of the pattern was absent:

- **No research/delivery boundary.** `postToSlack` was called from the middle of the gather
  function, so you could not get the health data without posting it, or post a report you had
  gathered elsewhere. Slack was a step, not a destination.
- **No reusable units.** The CLI-drift check, the container check and the repo-config check
  are three independent concerns sharing one failure path — a `docker ps` failure degraded
  all three to `"unknown"` in one place.
- **One retry policy** for shelling out to a host, calling three registries, and posting to
  Slack: three very different failure modes with three very different right answers.

## The decomposition

```
infrastructure-health-report        schedule: gather, then deliver (≈130 lines, mostly comment)
├── infra-health-research           batch.triggerByTaskAndWait, 3 entries → InfraHealthReport
│   ├── check-cli-drift             execFile infisical/letta/claude + registry lookups
│   ├── check-service-groups        docker ps vs expected containers
│   └── check-repo-config-drift     repo file regex vs upstream releases
└── infra-health-deliver            batch.triggerByTaskAndWait, 2 entries
    ├── infra-deliver-slack
    └── infra-deliver-gdoc          NEW destination
```

Supporting modules: `src/lib/infra-health.ts` (types, version comparison, rollup, rendering),
`src/lib/host-commands.ts` (the one place this project shells out to the host),
`src/lib/infra-delivery.ts` (the `delivered | skipped | failed` vocabulary),
`src/lib/infisical.ts` (the old secret fetch, now a fallback),
`src/lib/google-{auth,docs}.ts` (copied from `executive-assistant`).

## The seam: `InfraHealthReport`

```ts
{ date, generated_at, repoRoot, cliResults, serviceResults, repoResults,
  overallStatus: "healthy" | "drifting" | "degraded" | "unknown", warnings }
```

Structured, not rendered — Slack wants Block Kit, Drive wants markdown tables, and a future
destination will want rows. Rendering (`buildSlackText`, `buildSlackBlocks`, `buildMarkdown`)
lives in `lib/infra-health.ts` and is called by the DELIVERY half only, which is what makes
`postToSlack` unreachable from the gather step by construction rather than by discipline.

**`overallStatus` is computed once, in the seam.** The old report posted three lists and left
the reader to decide, so a missing `caddy` container looked exactly as urgent as a
patch-behind CLI. The rollup is ordered rather than a count: a missing container beats an
outdated CLI, and "could not tell" is tracked separately in `warnings` rather than being
silently folded into "fine".

## Decisions worth defending

**The three checks fan out.** They are independent — none feeds another — so concurrency is
free wall-clock, but the real gain is per-check retry and per-check failure boundary. A
GitHub rate limit now costs one `unknown` row in the CLI table instead of blanking the
container check. `check-cli-drift` and `check-repo-config-drift` retry (network calls);
`check-service-groups` does not (`docker ps` is either available or it is not, and no retry
changes that).

**A check task that dies outright is reported, not fatal.** `infra-health-research` turns a
failed child into `unknown` rows carrying the error text. A health report that fails to
render because one of its three sections broke is strictly worse than one that says "I could
not check containers, here is everything else."

**`missing` stays empty when a service group's status is `unknown`.** The old code set
`missing` to the entire expected list when `docker ps` failed, which on any dashboard showing
only `missing` read as "every container is down" — a false alarm indistinguishable from a
real outage.

**Google Docs is the second destination, and that is the point.** Slack is a notification you
read once; a daily health report is also a record you want to look back through ("when did
caddy first go out of date"). Drive's markdown import renders `buildMarkdown`'s tables as
real Doc tables. It defaults to a rolling document (`WATCHDOG_GDOC_DOCUMENT_ID`) so a
bookmark keeps working, with dated-archive mode if only a folder is set — the same two modes
`executive-assistant/tasks/deliver-gdoc.ts` uses.

**Failure isolation matters more here than anywhere else in the repo.** The one workflow
whose job is to tell you something is broken should not be the workflow that goes quiet when
something is broken. A Drive 403 cannot cost you the Slack alert, and the gathered report is
returned on the run's output regardless — a delivery channel of last resort.

**The hardcoded developer path is gone.** `resolveRepoRoot` no longer probes
`/home/jaewilson07/GitHub/simpleDiscordBot`, which cannot exist in a deployed container and
made the check look configurable when it was not. `INFRA_MONOREPO_ROOT` is now the only way to
point it at a real checkout, and when nothing is found the check says so as its stated reason.
The other half of R3 — reading those config files over an API so the check works in a
container — is **not done**: no such API exists and inventing one is a larger change than this
rework. Documented rather than silently half-finished.

**`timestamp` is now accepted as `Date | string`.** `schedules.task` payloads carry a real
`Date` when the scheduler invokes them and a JSON string when a human triggers them from the
dashboard or API. The pre-rework code called `payload.timestamp.toISOString()` directly and
crashed with `toISOString is not a function` on every manual run — which is also why it had
never been exercised by hand. This was found by trying to test it.

## Infisical: fallback, not primary (audit R3, partially)

R3 suggested adopting the `syncEnvVars` build extension and deleting
`fetchInfisicalAccessToken`/`fetchInfisicalSecret`. **The functions were kept**, and the
reason is a live deployment: the watchdog project had no `DATACREW_SLACK_BOT_TOKEN` env var
set, so deleting the Infisical path would have broken the running schedule on the next
deploy.

Instead `infra-deliver-slack` reads the environment **first** and falls back to Infisical.
The ordinary path now costs zero extra HTTP round trips (the old code paid an auth call plus
a secret fetch on every single report) and no longer fails entirely when Infisical is down,
while an unconfigured deployment keeps working unchanged. `DATACREW_SLACK_BOT_TOKEN` has since
been set on the project, so the fallback should now be dead code — adopting `syncEnvVars` and
deleting `src/lib/infisical.ts` is a safe follow-up, deliberately left as a separate change.

## New env vars on `proj_wxqgcxxcutibtcgxlzky`

`GOOGLE_TOKEN_API_KEY`, `DATACREW_SLACK_BOT_TOKEN` (both from Infisical),
`AUTH_SERVICE_URL`, `WATCHDOG_GDOC_OWNER_EMAIL`. `googleapis` was added to
`watchdog/package.json`; `infra-deliver-gdoc` carries `machine: "small-2x"` for the same
measured reason the other two projects' Drive tasks do — importing `googleapis` SIGKILLs on
the 0.5 GB default before any user code runs.

## Verification

**`infra-deliver-gdoc`, live** (run `run_cmsfowi3n004z4ilaq2wbfqyl`):

```
STATUS: COMPLETED
{ destination: "gdoc", status: "delivered", created: true,
  url: "https://docs.google.com/document/d/1-o0hDNjoHglH7llNP0EXL_zzX5HJZTzEScV_2Xq8j7w/edit" }
```

**`infra-health-research`, live** (run `run_cmsfou0zs004k4ila67ois64n`): COMPLETED, all three
checks fanned out as separate child runs.

```
infra-health-research      COMPLETED   overallStatus "unknown"
├── check-cli-drift        COMPLETED   3 unknown rows, one reason per tool
├── check-service-groups   COMPLETED   docker unavailable → both groups unknown, missing: []
└── check-repo-config-drift COMPLETED  "no infra monorepo found — set INFRA_MONOREPO_ROOT"
```

Every "could not tell" carries its own stated reason and lands in `warnings` — correct
behaviour for a container with none of those binaries and no repo mounted, and exactly the
"say why, don't guess" posture the rework aimed for. Note `missing: []` on the unknown
service groups: the old code would have reported every expected container as missing here.

**`infra-health-deliver`, live** (run `run_cmsfp5aub005w4ila5nko1pbh`): COMPLETED in 385 ms,
both destinations in parallel.

```
infra-health-deliver       COMPLETED   deliveredCount 1, skippedCount 1
├── infra-deliver-slack    skipped     "disabled by caller"
└── infra-deliver-gdoc     delivered   (see the Google Doc above)
```

## Blocked: the entry point cannot reach its children

`infrastructure-health-report` fails with

```
TriggerApiError: 403 status code (no body)
```

on its first `triggerAndWait`, reproducibly (4 attempts). **Both halves it orchestrates work
perfectly when triggered directly** — see the two runs above.

The root cause is diagnosed in full in `docs/storm-research-rework.md`: the bot-gate in front
of `triggers.datacrew.space` demands a Turnstile token on `POST /api/v1/tasks/*/trigger`, and
its documented "any `Authorization: Bearer` is exempt" bypass is in fact an **allowlist of
specific API key values**. The `executive-assistant` key is on it; the `watchdog` and
`storm-research` keys are not. `POST /api/v1/tasks/batch` is not matched by the gate rule at
all, which is exactly why this project's two batch fan-outs succeed and its single
`triggerAndWait` does not.

**This is the one place the rework carries a real regression risk, and it should not be
glossed over.** Before it, `infrastructure-health-report` had zero child tasks, so it never
needed the capability the gate is blocking. After it, the 14:00 UTC schedule depends on it and
will fail until the allowlist is fixed.

Three options, in order of preference:

1. **Fix the gate** (one entry in `homeserver/services/auth/gate_router.py`, or make the
   Bearer bypass unconditional as `AGENTS.md` already claims). Everything then works, and it
   also unblocks storm-research and any external caller using a non-EA key.
2. **Revert `src/trigger/infraHealthReport.ts`** to the previous commit if the daily report
   matters before that lands. The five decomposed tasks are purely additive and can stay
   deployed alongside the old monolith.
3. Restructure the entry point to reach its halves through a one-entry batch. Rejected: that
   contorts correct composition to dodge a misconfigured WAF, and the contortion would
   outlive the misconfiguration.

---

## Since: Notion (2026-08-05)

A Notion destination was added to every workflow in the repo — see
`docs/notion-delivery.md`. `infra-health-deliver`'s batch went from two entries to three, plus one new
`src/trigger/tasks/infra-deliver-notion.ts`. For a watchdog the third destination
earns its place: Notion shares no vendor, token or network path with Slack or
Drive, so an outage in either cannot silence the report entirely.

The point worth recording here is the cost: adding a destination that reaches four
workflows took one library, three thin tasks, and one entry per fan-out, with no
research code touched. That is what the split in this document was for.

---

## Since: the bot-gate blocker above is fixed (2026-08-07)

The "Blocked: the entry point cannot reach its children" section above is no
longer current — option 1 (fix the gate) is what happened. The gate now
validates a presented key live against `GET /api/v1/whoami` instead of
string-comparing it to one hardcoded (`executive-assistant`-only) value, so
`watchdog`'s prod key clears it like any other project's, and
`infrastructure-health-report`'s 14:00 UTC schedule reaches its children
again. See `AGENTS.md` → "Invoking these tasks from outside" for the
live-verified detail, and
`docs/ADR-002-research-seam-delivery-composition.md` → "Addendum" for how
this fits the repo-wide composition pattern. Left in place above rather than
deleted — this document is a decision record, and the diagnosis was correct
at the time it was written.
