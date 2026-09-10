# teach — the `/teach` skill as an unattended workflow

Built following simpleDiscordBot's `create-workflow` skill, which is the design
pattern for workflows on this infrastructure. This document is that skill's
step 1 — the phase table, written before any code.

## What is being rebuilt

`/teach` is Matt Pocock's skill (vendored in the `mattpocock-skills` plugin). It
treats the working directory as a teaching workspace and keeps mission, lessons,
reference documents, resources and learning records as files. It is explicitly a
**stateful, multi-session** request.

It is already about 80% workflow-shaped: state lives in files, phases are
ordered, each phase reads what the last one wrote. What it lacks is anything
that runs when the learner is not typing — and three of its own requirements
need exactly that:

- **Resource hunting.** "Before the `RESOURCES.md` is well-populated, your focus
  should be to find high-quality resources... Never trust your parametric
  knowledge." That is a search job, not a conversation.
- **Spacing.** The skill asks for storage strength via "spacing (distributing
  practice over time)". Nothing that only runs on demand can distribute anything.
- **Gaps.** `RESOURCES.md`'s `## Gaps` section exists to "drive future search".
  That is a work queue with no worker.

## Durable state: mdrag's learn vault

The vault (`/api/v1/learn/*`) already models this workspace — `set_mission`,
`create_lesson`, `create_reference`, `add_learning_record`, and a workspace index
listing all of them. It is the **Store**; trigger.dev carries nothing between
runs. That is `create-workflow` step 2, and adopting an existing Store rather
than inventing one is the whole reason this workflow is small.

Two consequences worth stating plainly:

- **A run is disposable.** Kill one mid-flight and the workspace is still
  coherent, because every artifact was committed through a vault writer.
- **The vault is scoped by the caller's token**, so identity is not a workflow
  concern. `DATACREW_API_TOKEN` resolves to emmabot — the default for DataCrew
  work. A personal (alix) workspace is a different token and an explicit choice.

Gaps against the source spec — `RESOURCES.md`, `GLOSSARY.md`, `NOTES.md` and a
shared `assets/` directory — are tracked as jaewilson07/mdrag#1545. Until then
RESOURCES rides in a `reference` document, which works because reference ids are
upsert-by-name. The write endpoints themselves are jaewilson07/mdrag#1543.

## Phase table

| # | Phase | Reads | Produces | Pattern | Attended? |
|---|---|---|---|---|---|
| 1 | Mission interview | the learner | `MISSION.md` | — | **Human.** Stays in the skill |
| 2 | Hunt resources | mission, `## Gaps` | scored candidates | **Parallelization** | Unattended ✅ built |
| 3 | Vet resources | candidates | `RESOURCES` reference | **Gate** (`critique`) | Unattended ✅ built |
| 4 | Pick next lesson | learning records, mission, glossary | `LessonBrief` | **Routing** | Unattended — next |
| 5 | Draft lesson | brief + vetted resources | `LessonDraft` | **Prompt chain**, capped critique loop | Unattended — next |
| 6 | Render lesson | draft + `assets/` | `lessons/NNNN-*.html` | — | Unattended — next |
| 7 | Spaced review | learning records + dates | retrieval-practice lesson | **Scheduled** | Unattended — next |
| 8 | Grade understanding | learner's answers | `learning-records/NNNN-*.md` | — | **Human.** Stays in the skill |

Phases 1 and 8 are the ones that genuinely need a person. Phase 8 especially:
the skill is explicit that coverage is not learning and a record is only written
on *evidence* of understanding — a workflow that wrote its own learning records
would corrupt the very signal phase 4 reads to pick what to teach next.

## Task sizing

`create-workflow` step 1: size a task by what you can afford to re-run, and
never fuse an expensive external fetch with the LLM step that consumes it.

Concrete here rather than abstract — the shared search pool is scarce (roughly
four Pattern Hunter runs is enough to suspend it). So search and vetting are
separate child tasks, and a failed critique can never re-fire the searches that
fed it. Both orchestrators run `retry: { maxAttempts: 1 }` for the same reason:
by the time anything above can fail, the pool has already been spent.

## Where the evaluator-optimizer must stay capped

Phase 5 drafts a lesson and critiques it. That loop is a workflow only while its
retry bound is fixed. Letting the gate re-run the drafting phase as many times
as it likes, on its own judgement, is the single change that makes the whole
thing an agent — with a different cost profile and different guarantees. Cap it.

## Observability

Per ADR-049, crew-logger and Langfuse are complementary: crew-logger is
Datadog-shaped structured logs, Langfuse owns agentic tracing. The IDs are one
space — `trace_id` = one workflow run, `span_id` = one task, `session_id` = the
long-lived subject, which for this workflow is the **workspace slug**: a mission
outlives every run against it, which is exactly what a session id is for.

Today these tasks emit `logger.info` per this repo's own
`workflow-observability-standard.md`, which predates ADR-049 and carries no
correlation ids at all. Reconciling the two is not done here — Langfuse is not
deployed (jaewilson07/infra-bonker#609), and the honest build order is
crew-logger correlation first, Langfuse observations later, same id space, no
rework.

## Files

| | |
|---|---|
| `executive-assistant/lib/learn-vault.ts` | Typed client for the vault: the Store's read and write surface |
| `executive-assistant/tasks/teach/hunt-resources.ts` | Phases 2–3: search fan-out + trust gate |
| `executive-assistant/teach-resource-hunt.ts` | Orchestrator: read workspace → hunt → render → persist |
