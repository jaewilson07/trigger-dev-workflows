# ADR 0003: Project registry — mdrag upstream, Paperclip downstream, 📎-intake single write path

Status: accepted (2026-10-12)

## Context

Matching quality lives or dies on the scanner knowing what each project is
*about*. Live check during the session: 12 Paperclip projects, only 1 with
goals populated; statuses stale (the-ai-cfo `backlog` while live on Domo).
Jae also loses projects — there is no one door. Paperclip hygiene was
inconsistent because tracking depended on Jae remembering to ask, and agent
memory cannot fix that.

## Decision

Project docs live in mdrag (scope note mandatory); Paperclip is the work
projection; every project also gets a Slack thread (parent in #projects) —
**1:1:1, created together, IDs cross-linked both ways**. The only creation
path is 📎-intake: a 📎 reaction triggers bot-layer `reaction_added` handling
(deterministic code, not agent memory), the owning agent DMs for context
(type, project, one-line why), semantic dedup runs against existing projects
("80% like X — new or fold in?"), the three artifacts are created, the
conversation is saved with `content_class: "transcript"`, and ✅ stamps the
original message as receipt and idempotency guard. Field ownership: mdrag
owns what/why, Paperclip owns status/tasks. A one-time backfill drafts scope
notes and repo links for the existing 12.

## Consequences

- Direct Paperclip project creation is deprecated; the 1:1:1 invariant holds
  by construction.
- Slack app needs `reaction_added` subscription and `reactions:read` scope.
- A #projects channel is created; the channel history becomes the project index.
- The shared `paperclip-intake` runbook is symlinked to all three agents, so
  intake behavior is identical whoever owns the channel.
