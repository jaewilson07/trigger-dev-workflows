# ADR 0001: General signal-intake framework, Cole Medin as Feed #1

Status: accepted (2026-10-12, grill-with-docs session, Jae + IdrisBot)

## Context

The originating ask was a Cole Medin watcher. The underlying capability —
watch sources, extract concepts, map to projects, propose work — is the
factory's intake line and will be wanted for other sources (Lenny Rachitsky,
Letta changelog, Domo release notes, LiveKit).

## Decision

Build a general framework with a Feed Registry; Cole's YouTube channel,
`coleam00` GitHub activity, and `cole-medin-ai-coding` releases are the first
rows. DataCrew's existing changelog monitors get *registered* as Feeds, not
rebuilt.

## Consequences

- A new Feed is a config row in `feeds.yaml`, opened as a PR — not a code change.
- A new source *type* costs exactly one Monitor adapter.
- The registry abstraction must not leak Cole-specifics; anything Cole-shaped
  lives in his rows' config.
