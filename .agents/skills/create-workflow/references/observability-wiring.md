# Observability wiring — Langfuse + crew-logger

Both, not either. umbrella **ADR-049** (archived at jaewilson07/simpleDiscordBot@3b0775e28; accepted 2026-08-08, consolidated 2026-08-09) is
the single canonical ADR for this topic and already settled the split.

## The split

- **crew-logger (`cl`) is Datadog-shaped** — plain structured log entries
  correlated by shared IDs, with **nothing LLM-typed in the baseline schema**.
  `from cl import get_logger`. House standard: never `print()`, never stdlib
  `logging`.
- **Langfuse is the agentic-tracing layer** — it fuses "log line" and "trace
  step" into one typed object graph; an `observation` carries
  `type: GENERATION|TOOL|SPAN|...`, token usage, cost, prompt version.
  ADR-049's own wording: agentic tracing is Langfuse's job, **not**
  crew-logger's.

## One ID space

ADR-049 fixed the correlation IDs for chatbot turns. They extend to workflow
runs without change:

| ID | Chatbot meaning (ADR-049) | Workflow-run meaning |
|---|---|---|
| `session_id` | the whole conversation | the long-lived subject (mission, workspace, project) |
| `trace_id` | **one turn** | **one workflow run** (one trigger.dev root run) |
| `request_id` | one HTTP/WS request within a turn | one task attempt |
| `span_id` / `parent_span_id` | one hop (LLM call, tool call), chained | one node/task, chained to its parent |

**Wiring rule:** mint `trace_id` at the workflow root; thread it through every
child task's payload; emit crew-logger lines at every task boundary carrying
those IDs; emit a Langfuse observation for every model and tool call with the
same `trace_id`.

## Deployment status — read before planning

**Langfuse is NOT deployed** (verified 2026-09-10):

- `https://langfuse.datacrew.space/` returns **404**
- a cloudflared tunnel hostname exists and points at caddy
  (`infrastructure/cloudflared/config.yaml` in `infra-bonker`)
- there is **no Caddy site block**, **no langfuse app directory under `apps/` in `infra-bonker`**, and **no container**
- the CF-Access adoption tracker records it as "No route, no container in this
  repo"

Any plan assuming Langfuse tracing works today is wrong. Deploying it is
prerequisite work, not a wiring detail. MinIO on bonker is already documented as
the shared object store "for Langfuse event data," so some groundwork exists.

**Tracked:** [jaewilson07/infra-bonker#609](https://github.com/jaewilson07/infra-bonker/issues/609)
— deploy Langfuse at `langfuse.datacrew.space`. Its design-side counterpart is
[simpleDiscordBot#562](https://github.com/jaewilson07/simpleDiscordBot/issues/562).
Check #609's status before designing anything that emits Langfuse observations.

crew-logger, by contrast, is live and is the existing house standard — a
workflow can ship with crew-logger correlation IDs today and gain Langfuse
observations later without changing the ID space. Build in that order.

## Consuming crew-logger

`cl` is distributed from the PEP-503 index at `datacrew.space/packages/`.
Note the known gotcha: the **directory form is broken for pip/uv** (Cloudflare
Pages 308s `/packages/<pkg>/` into the Next.js catch-all, so installers see a
200 with zero versions). Point at the `index.html` with `--find-links` instead.
