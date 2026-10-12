# ADR 0009: Project Zero — the system captures itself; name

Status: accepted (2026-10-12)

## Context

agentic-rss-feed is itself a project. The 📎-intake flow doesn't exist yet,
so the system cannot capture itself through its own mechanism. The manual
bootstrap is an opportunity: execute the 1:1:1 pattern by hand and write the
📎-intake runbook from a real execution instead of an imagined one.

## Decision

Capture agentic-rss-feed as **Project Zero**, manually: (1) mdrag project
doc (scope note + the eight decisions + links), (2) Paperclip project with
the scope note as its goal, (3) #projects channel created, parent message
posted, thread ts recorded, (4) IDs cross-linked all three ways. The spec
(issue #270) and these ADRs are the project's first linked artifacts. The
runbook written from this execution becomes `paperclip-intake`'s first
draft. Name: **agentic-rss-feed** (Jae's pick) — intake-vs-output caveat
recorded; CONTEXT.md defines the term.

## Consequences

- The setup checklist executes once, manually, before automation exists:
  `proposed-by-ai` labels in target repos, `factory-inbox` repo, #projects
  channel, Slack `reaction_added` + `reactions:read`, DataCrew Friday time.
- Future projects never take this path manually again.
