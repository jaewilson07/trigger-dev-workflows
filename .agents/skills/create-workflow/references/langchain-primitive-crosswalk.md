# LangChain / LangGraph vocabulary → DataCrew implementation

We read LangChain's docs as a design vocabulary. We do not install LangGraph.
Sources are the LangChain docs ingested into mdrag; document titles are given
so they can be re-queried with `query_rag`.

## The razor — both frameworks draw the same line

Anthropic (*Building Effective Agents*): **workflows** orchestrate LLMs and
tools through **predefined code paths**; **agents** let the LLM **dynamically
direct its own processes and tool usage**.

LangChain (*What's new in LangChain v1*, *LangChain overview*) draws it as a
loop: an agent is a model plus a harness (prompts, tools, middleware) that calls
the model, lets it choose tools, and repeats **until it calls no more tools**.

Apply it **per step**. A workflow may contain exactly one agentic node without
becoming an agent.

**Practical test:** if you can write the complete
`phase -> reads this schema -> produces that schema` table before any run
happens, it is a workflow. If only the start and stop-condition are
specifiable, it is an agent.

## Crosswalk

| LangChain / LangGraph | DataCrew implementation |
|---|---|
| tool | one trigger.dev `task`, or an mdrag MCP tool; schema inferred from signature + docstring |
| node | one trigger.dev `task` |
| edge | `triggerAndWait` / `batch.triggerByTaskAndWait` |
| shared state | task payload (in-run) + git/mdrag (cross-run) |
| checkpointer — thread-scoped run state | trigger.dev durable execution, checkpointed at task boundaries |
| **Store** — long-term cross-thread memory (preferences, facts, shared knowledge) | **git files and/or mdrag Documents**, never trigger.dev |
| `interrupt` (human-in-the-loop) | trigger.dev **waitpoints** |
| durability modes (`exit` / `async` / `sync`) | trigger.dev's own durability |
| parallel nodes | `batch.triggerByTaskAndWait` |
| agent tool-calling loop | one task using `ai.tool` |
| Graph API vs Functional API | Functional-API-shaped: normal control flow in task code, no graph DSL |

## Node granularity is a failure-recovery decision

*Thinking in LangGraph*: checkpoints are created at **node boundaries**, and a
resumed run restarts from the **beginning of the node where it stopped**.
Smaller nodes mean more frequent checkpoints and less repeated work; fusing
operations into one large node means a failure near the end re-executes
everything from that node's start.

Restated: **size a trigger.dev task by what you can afford to re-run.**

## Multi-agent architectures, mapped

LangChain's named architectures are the same five patterns under other names:

- **Custom workflow** — "you define your own bespoke execution flow"; full
  control over structure. = orchestrator-workers.
- **Handoffs** — "behavior changes dynamically based on state"; tools update a
  state variable (`current_step`, `active_agent`) naming whose turn it is.
  = routing. Log every transition.
- **Supervisor / subagents** — a main agent calls subagents as tools; subagents
  are **stateless** and the main agent owns all state. Bought for context
  isolation, paid for in central complexity. = orchestrator-workers.

## Why not LangGraph as a runtime

Its primitives duplicate trigger.dev's one-for-one (see crosswalk). Adopting
both means two checkpointers, two retry models, and two deploy-versioning
stories over the same work. LangGraph's own *Backward compatibility* doc names
the versioning hazard — a redeployed graph runs against state written by the
old one — which trigger.dev already answers its own way.

**The one place LangChain could still earn a dependency** is the agentic node
itself (`createAgent` with middleware, inside a single trigger.dev task).
Compare against the AI SDK that `trigger-agents` already uses before adding it.
