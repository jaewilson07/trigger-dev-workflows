# ADR 0006: Issue routing — per-repo with factory-inbox fallback; action types

Status: accepted (2026-10-12)

## Context

Proposals need a filing destination. Three surfaces exist: GitHub (machine
work queue — issue-agent-driver claims `ready-for-agent` issues per repo),
Paperclip (human project board), Slack thread (notification feed). Jae also
surfaced that proposals are not always code: a Domo release note may warrant
a blog post or community answer.

## Decision

GitHub issues file to the **Project's own repo** when the registry records
one (`repo` field is load-bearing; intake captures it, backfill fills it),
else to `factory-inbox`. Every proposal carries an **action type**:
`extend-codebase` | `write-content` | `update-skill` | `refresh-research`;
issue templates key off it. Paperclip stays the human board (links, no
duplication); the Project's Slack thread is the notification layer (every
filing lands as a reply).

## Consequences

- `proposed-by-ai` label created in every target repo at setup.
- Accepted proposals can be re-labeled `ready-for-agent` for the driver.
- Non-code work flows through the same engine with type-appropriate templates.
