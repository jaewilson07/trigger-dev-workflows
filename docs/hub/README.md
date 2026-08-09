# Documentation hub

Explainer docs: **how a thing works right now**, structural and evergreen —
not a decision record.

This is a different genre from the rest of `docs/`. The `*-rework.md` files
(`watchdog-rework.md`, `storm-research-rework.md`, etc.) are decision
records — they capture *what changed, when, and why*, and they stay
historically accurate even after the thing they describe evolves further.
An explainer has no such obligation: it should always describe the current
state, and gets edited in place (not superseded/addended) when that state
changes. If you're documenting "we decided X because Y", it's a rework doc
in `docs/`. If you're documenting "here's how X actually works today,
end to end", it belongs here.

## Entries

- [`ingest-community-sources.md`](./ingest-community-sources.md) — how
  Domo community source ingestion (forums, docs) actually works today, and
  what doesn't exist yet.
- [`trigger-dev-auth.md`](./trigger-dev-auth.md) — how self-hosted
  trigger.dev's programmatic API auth actually works (token types,
  validation path, the trigger endpoint contract). For where the real
  per-project credentials live and how to fetch/set them, see
  `.agents/skills/trigger-project-credentials` at the simpleDiscordBot root.

## Adding an entry

One file per topic, named for the thing it explains (not for the task that
created it). Cross-link to the relevant `*-rework.md` decision record(s) and
issue(s) rather than repeating their history — the hub explains current
shape, the rework doc explains how it got there.
