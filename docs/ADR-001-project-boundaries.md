# ADR-001: Project boundaries — `watchdog` is infrastructure, `executive-assistant` is everything assistant-facing

**Status:** Accepted (2026-08-08); see [Addendum (2026-08-19)](#addendum-2026-08-19--a-third-domain-indb-blues) for a third domain
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

- `storm-research`'s `AGENTS.md` and any future satellite projects' should
  say up front which domain they belong to, not just describe themselves in
  isolation.
- Root `package.json`'s `workspaces` array didn't actually include
  `storm-research` (an oversight independent of this ADR, fixed alongside
  it) — every current project is now a real npm workspace member.
- Doesn't change anything about the composition pattern
  (research/seam/delivery) or the `delivered | skipped | failed` vocabulary
  — this is purely about which project a task's code lives in, not how it's
  structured once it's there.
- **2026-08-12:** the "separate, purely mechanical question" this ADR left
  open — folding `storm-research` into `executive-assistant`'s own deploy —
  was answered: yes. Domain boundary and deploy boundary now coincide for
  it. See `docs/storm-research-rework.md`'s addendum for the mechanics and
  why (it also closed `trigger-dev-workflows#45`, a credential gap
  `storm-research`'s standalone deploy had never resolved).

## Addendum (2026-08-19) — a third domain: `indb-blues`

`indb_discordbot`'s Blues Music Drops newsletter needed to move off a dead GitHub
Actions cron and onto this repo's composition conventions (see
`docs/ADR-002-research-seam-delivery-composition.md`), which meant answering this
ADR's own question for it: does it exist to tell a human something about the
assistant/Slack/website, or to keep some other system correct regardless of
whether a human is watching? **Neither.** It's a weekly community-facing
publication (Discord + a public Notion database) — no assistant/Slack/website
surface at all (ruling out `executive-assistant`), and a human audience is the
entire point (ruling out `watchdog`).

**Decision:** a third domain, **community/product-facing publishing** —
workflows whose audience is people beyond Jae himself, as opposed to
`executive-assistant`'s scope (Jae's own calendar/inbox/Slack) or `watchdog`'s
(no human audience at all). First project in it: **`indb-blues`**
(`trigger-dev-workflows#96`-`#101`), deployed the same way every other project
here is — own `package.json`/`trigger.config.ts`, depends on
`@datacrew/trigger-shared`, own Infisical-stored secret key. Reuses the
`git-uv` clone-and-run bridge (`packages/shared/src/git-uv.ts`, originally
built for `watchdog`'s `crew-rag-domo-scrape`) to invoke `indb_discordbot`'s
existing Python runbooks rather than porting their logic to TypeScript — the
same shared infrastructure, a different domain.

**How to apply, updated:** a new task now gets three questions, not two —
assistant/Slack/website surface (`executive-assistant`), no human audience
(`watchdog`), or a publication reaching people beyond Jae
(`indb-blues`, or a future sibling in the same domain if the audience/product
differs enough to warrant its own deploy boundary, same reasoning ADR-001
already applies to `watchdog` vs. `executive-assistant`).

**Consequences:** `AGENTS.md`'s "Project boundaries" section now lists three
projects instead of two. Nothing about the composition pattern
(research/seam/delivery) or the `delivered | skipped | failed` vocabulary
changes — same as the original ADR's own Consequences already noted, this is
purely about which project a task's code lives in.

## Related

- `AGENTS.md` — "Project boundaries" section links here.
- `docs/watchdog-rework.md`, `docs/storm-research-rework.md`,
  `executive-assistant/docs/morning-brief-rework.md` — the per-project
  composition rework docs this ADR sits alongside, not above.
- jaewilson07/trigger-dev-workflows#18 — the crew-rag-domo scrape task that
  prompted writing this down.
- jaewilson07/trigger-dev-workflows#96 — the Blues Music Drops PRD that
  prompted the 2026-08-19 addendum.
