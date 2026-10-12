# ADR 0007: Weekly Sweep, Friday-aligned; per-feed cron overrides

Status: accepted (2026-10-12)

## Context

Three clocks: monitor polling, analysis, notification. Cole posts 1–2 videos
a week; a daily sweep mostly finds nothing and trains Jae to ignore it.
Attention is the scarce resource, not compute. Jae believes DataCrew's
existing weekly digest posts Fridays and wants alignment ("let's keep that").

## Decision

One weekly **Sweep** — a trigger.dev `schedules.task` in executive-assistant,
composed stages: poll → ingest → extract → match → file → notify — running
just before DataCrew's Friday digest so all weekly review lands in one batch.
Each Feed row may carry a cron override; default inherits the weekly Sweep.
Awaiting-triage >10 escalates with an @mention.

## Consequences

- Build-time verification: DataCrew's Friday post time was not found in code
  during the session; confirm and set the Sweep before it (Thursday evening
  likely).
- Split cheap-poll/batch-analysis stays a future option when feed count makes
  the weekly sweep chunky.
