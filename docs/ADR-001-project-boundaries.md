# ADR-001: Project boundaries — `watchdog` is infrastructure, `executive-assistant` is everything assistant-facing

**Status:** Accepted (2026-08-08)
**Decider:** jaewilson07

## Context

This repo now deploys three separate Trigger.dev projects — `watchdog`,
`executive-assistant`, `storm-research` — each with its own `package.json`,
`trigger.config.ts`, and Infisical-stored secret key (see `AGENTS.md`'s
"Invoking these tasks from outside" section). What determines which project a
*new* task belongs in was never written down; it was inferred from whichever
project happened to look closest at the time. That works until it doesn't —
two people (or two agent sessions) picking different homes for the same kind
of task silently forks the pattern, and the composition conventions
(`docs/*-rework.md`) already established per project drift apart for no
reason.

This became concrete while migrating `hector-dcs/crew-rag-domo`'s daily
scrape off GitHub Actions (issue #18): the task is plainly infrastructure
automation (scrapes an external source, writes back to a repo, on a cron —
no Slack/assistant surface at all), and went into `watchdog` without a second
thought. That instinct is worth writing down before the next ambiguous case
doesn't have as obvious an answer.

## Decision

**`watchdog`** — infrastructure triggers. Tasks that keep the *house's own
systems* honest: health/service/CLI/repo-config drift checks
(`infra-health-research` and its children), repo monitoring
(`repo-monitor-report`), and cron-driven data-pipeline jobs that exist to
keep some other repo or service in sync (`crew-rag-domo-scrape`). The common
thread is that no human is a first-class participant in the run — the
audience is a Slack channel, a Notion page, or a git commit, and the task
would still make sense if DataCrew as a product didn't exist.

**`executive-assistant`** — every workflow whose reason to exist is serving
the assistant, the Slack bots, or the website. Email digest, morning brief,
Pattern Hunter (chat, research, hypotheses, red-team, context snapshots),
report/brief delivery, and **`storm-research`** all belong here *by domain*,
even though `storm-research` is deployed as its own separate Trigger.dev
project (own secret key, own `package.json`) rather than living inside the
`executive-assistant` project itself. Domain boundary and deploy boundary
are two different axes — this ADR governs the former. `storm-research`
follows `executive-assistant`'s composition conventions and status
vocabulary, not `watchdog`'s, and any future decision to fold it into the
same Trigger.dev deploy as `executive-assistant` is a separate, purely
mechanical question this ADR doesn't need to answer.

**`packages/shared`** (`@datacrew/trigger-shared`) is neither — it's the
cross-cutting infrastructure (Infisical helpers, the git+uv build extension)
both domains depend on, per issue #17.

## How to apply this

New task, ask one question: *does this exist to tell a human something about
the assistant/Slack/website, or does it exist to keep some other system
correct regardless of whether a human is watching?* The former is
`executive-assistant`-domain (deployed there, or as a `storm-research`-style
satellite if it needs deploy isolation). The latter is `watchdog`.

## Consequences

- `storm-research`'s `AGENTS.md` and any future satellite project's should
  say up front which domain they belong to, not just describe themselves in
  isolation.
- Root `package.json`'s `workspaces` array didn't actually include
  `storm-research` (an oversight independent of this ADR, fixed alongside
  it) — every current project is now a real npm workspace member.
- Doesn't change anything about the composition pattern
  (research/seam/delivery) or the `delivered | skipped | failed` vocabulary
  — this is purely about which project a task's code lives in, not how it's
  structured once it's there.

## Related

- `AGENTS.md` — "Project boundaries" section links here.
- `docs/watchdog-rework.md`, `docs/storm-research-rework.md`,
  `executive-assistant/docs/morning-brief-rework.md` — the per-project
  composition rework docs this ADR sits alongside, not above.
- jaewilson07/trigger-dev-workflows#18 — the crew-rag-domo scrape task that
  prompted writing this down.
