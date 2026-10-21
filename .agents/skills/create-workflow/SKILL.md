---
name: create-workflow
description: "Build a multi-step workflow on DataCrew infrastructure — trigger.dev as the orchestration runtime, mdrag as the knowledge substrate, emmabot/alix as the agent identity, Langfuse + crew-logger as the two observability sinks. Use for: \"build a workflow\", \"turn this into a pipeline\", \"orchestrate these steps\", \"make this run unattended\", \"schedule this as a recurring job\", \"how do we wire observability into a workflow\", \"which agent identity should this run as\". NOT for deciding whether the work is a workflow at all — that is `choose-agentic-primitive`, run it first."
metadata:
  version: 0.1.0
  created: 2026-09-10
---

# create-workflow

## Overview

`choose-agentic-primitive` decides *what kind* of thing to build. This skill
covers what to do once the answer is "workflow": which runtime, how to size
the steps, where durable state lives, whose identity acts, and how a run is
observed.

**The orchestration decision is settled — do not re-open it.** trigger.dev is
the runtime. LangChain/LangGraph are read as a *design vocabulary* and never
installed as a second runtime; n8n is not a candidate. Running LangGraph over
trigger.dev means two checkpointers, two retry models, and two deploy-versioning
stories over the same work.

Grounding for every claim below, with citations back into the LangChain docs in
the KB, is the mdrag Annotation
`2b314c80-18e5-50d7-ad2e-3ba5442587c5` (`kind=design_pattern`) — query it
rather than re-researching.

## Core Capabilities

- Sizes workflow steps into trigger.dev tasks by failure-recovery cost
- Splits run state from durable state so nothing important lives in the runtime
- Picks the right one of five orchestration patterns for each step
- Applies the emmabot/alix agent-identity rule
- Wires the two observability sinks onto one shared ID space

## When to Use

- `choose-agentic-primitive` returned "workflow" and you are about to build it
- An existing skill or runbook needs to start running unattended or on a schedule
- A pipeline exists but has no correlation IDs, no tracing, or no identity story

**Do not use** for classification (`choose-agentic-primitive`), for trigger.dev
mechanics (`trigger-tasks`, `trigger-agents`), or for deployment
(`deploy-trigger-tasks` — bonker-only, read it before you ship).

## Quick Start

1. Write the phase table **before any code**: `phase -> reads this schema -> produces that schema`. If you cannot complete it, you have an agent, not a workflow — go back to `choose-agentic-primitive`.
2. One phase = one trigger.dev `task`.
3. Decide per phase which of the five patterns it is (below).
4. Put every durable artifact in git or mdrag. Put nothing durable in trigger.dev.
5. Mint `trace_id` at the root task; thread it through every child payload.
6. Default the agent identity to **emmabot**; ask before using **alix**.

## Detailed Workflow

### Step 1: Size the tasks by what you can afford to re-run

LangGraph's checkpoints are created at node boundaries, and a resumed run
restarts from the **beginning of the node where it stopped**. Smaller nodes mean
less repeated work. Restated for trigger.dev: **never fuse an expensive external
fetch with the LLM step that consumes it** — a failed generation must not
re-crawl the web. This is how the "long jobs must be resumable" rule is
satisfied structurally instead of by bolting on retries.

### Step 2: Split run state from durable state

| Layer | Holds | Owner |
|---|---|---|
| Run state (LangChain's *checkpointer*) | one run's intermediate values | trigger.dev durable execution — free, build nothing |
| Durable state (LangChain's *Store*) | facts, preferences, artifacts, anything a later run reads | **git files and/or mdrag Documents** |

Conflating these is the most common design error. trigger.dev should carry
nothing between runs.

### Step 3: Pick the pattern per phase

Per `trigger-agents`: **Prompt chaining** (sequential + validation gates),
**Routing** (cheap classify, then dispatch), **Parallelization**
(`batch.triggerByTaskAndWait`), **Orchestrator-workers** (fan-out/fan-in),
**Evaluator-optimizer** (generate/evaluate loop — **must be capped**).

An evaluator-optimizer stays a workflow only while its retry bound is fixed.
Letting the gate re-run the producing phase an unbounded number of times on its
own judgment is the one change that makes the whole thing an agent.

Human approval is a **waitpoint**, not a polling loop.

### Step 4: Choose the agent identity

| Workflow is about | Identity | Rule |
|---|---|---|
| DataCrew / professional | **emmabot** | The default. Use it without asking. |
| Personal (jae) | **alix** | **Ask permission first.** Never route professional output through it. |
| Anything | a human's own token | Never, for agent-authored output. |

EmmaBot is the DataCrew agent service user (Domo user `1131239866`; the public
`datacrew-public` Slack bot), sharing `letta-datacrew.service` on bonker. It
exists because Domo Buzz has no sender override — without a dedicated identity,
agent replies post under a human's name.

**Caution:** EmmaBot's Domo token currently holds `super_admin`, copied from a
human "for now." Narrow it before anything long-lived depends on it.

### Step 5: Wire observability

Two sinks, one ID space, no duplicated payload. See
`references/observability-wiring.md` for the full table and the deployment gap.

### Step 6: Write findings back

Anything the run synthesizes that a later run should retrieve becomes an mdrag
Annotation (`mdrag-annotate-findings`), not a scratch file. Prefer extending
mdrag's existing staged pipeline (mdrag ADR-0019) over inventing a parallel engine.

## References

- `references/langchain-primitive-crosswalk.md` — LangChain/LangGraph term to DataCrew implementation, with source citations
- `references/observability-wiring.md` — Langfuse + crew-logger split, ID semantics, deployment status
- mdrag Annotation `2b314c80-18e5-50d7-ad2e-3ba5442587c5` — the researched design pattern this skill implements
- umbrella ADR-049 (archived umbrella jaewilson07/simpleDiscordBot@3b0775e28) — observability-and-logging (the canonical ADR for the two-sink split)

## Related Skills

- `choose-agentic-primitive` — run **first**; decides whether this skill applies
- `trigger-agents` — the five patterns as working trigger.dev code
- `manage-skills` — the router for everything else skill-shaped
