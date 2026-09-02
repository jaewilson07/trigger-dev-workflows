# mermaid-pipeline — build record

**Status:** Built, typechecked, unit-tested (51/51 passing, including real
`mermaid.parse()` validation). **Not yet deployed, not yet wired to
datacrew-site.** See "What's deliberately not done yet" below.

**Domain:** `executive-assistant` (ADR-001) — this exists to serve
datacrew-site's mermaid feature, not to keep the house's own infrastructure
correct. Lives at `executive-assistant/mermaid-pipeline.ts` (entry point) +
`executive-assistant/tasks/assistant/mermaid-*.ts` (standalone-triggerable stages) +
`executive-assistant/lib/mermaid-*.ts` (the actual logic, unit-tested
independently of the Trigger.dev runtime — same split every other task in
this project uses).

## Context

datacrew-site#218 proposed replacing mermaid generation's single "transcript
in, one LLM call, diagram out" step with a multi-stage pipeline: classify the
graph type first, distill into a type-specific structured spec, generate
Mermaid syntax mechanically from that spec, and validate before ever calling
a diagram "done." An n=6 eval of an earlier, simpler two-stage hypothesis
(generic prose distillation, no type routing) came back genuinely mixed — it
beat one-shot generation in aggregate but lost on the two failure modes it
was specifically meant to fix, because a plain-English intermediate is still
something a second model has to *reinterpret*, which is exactly where new
mistakes got introduced. This build is the type-routed redesign that mixed
result pointed at.

## Why this is a pipeline task, not a chat feature (mdrag#1141)

This repo's standing principle: Trigger.dev is for **non-interactive**
workflows; interactive thinking-partner conversations belong on the wiki/
website. This build doesn't move the mermaid **chat** anywhere —
datacrew-site's `/api/mermaid/generate` still talks directly to the user's
mermaid Conversation for the live, turn-by-turn revision loop the UI already
has, unchanged. What lives here is a bounded pipeline **transformation**
(transcript → validated diagram) with exactly one structured human-input
point, not an open-ended conversation — the same shape Pattern Hunter's
report-generation half already runs here while its interview half stays a
separate, explicitly open question (mdrag#1143). If this task ever needs a
second back-and-forth step, that's a sign it drifted into "interactive"
territory, not a reason to bolt on a second wait token.

## The four stages

1. **Classify** (`lib/mermaid-classify.ts`) — the state object the original
   design asked for. One stateless completion (gateway-first, Letta-fallback
   — `lib/mermaid-llm.ts`, mirroring `lib/gateway-llm.ts`'s existing split)
   returns `{graph_type, confidence, rationale}`. Below
   `LOW_CONFIDENCE_THRESHOLD` (0.55, chosen conservatively — not yet tuned
   against real data), the orchestrator does not guess.
2. **Blocking disambiguation** (`mermaid-pipeline.ts`) — a real
   `wait.createToken` / `wait.forToken` waitpoint, not a polling loop. The
   token's id/url/publicAccessToken are surfaced on `metadata.root` so a
   subscribing frontend can prompt the user (or an agent) and complete the
   token directly from the browser. On timeout, degrades to the classifier's
   own best guess rather than failing the run — this is where trigger.dev's
   actual human-in-the-loop primitive answers the original design question
   ("I'm sure trigger.dev has some blocking mechanism").
3. **Type-routed distill** (`lib/mermaid-distill.ts`) — three distinct
   prompts (flowchart/sequence/erd), each producing a STRUCTURED JSON
   intermediate (steps+edges / participants+messages / entities+
   relationships), not prose, with one worked example embedded per type.
   The render stage's remaining job is then a mechanical spec→syntax
   conversion, not a second interpretation pass — the langchain-graph
   "route to a specialist node" principle applied without adopting
   langchain itself, since trigger.dev's own task/wait primitives already
   cover the control flow it would otherwise provide.
4. **Generate + validate, evaluator-optimizer loop** (`lib/mermaid-render.ts`,
   `lib/mermaid-validate.ts`) — up to 3 stateless attempts, each fed the
   previous attempt's real parser error as corrective feedback (same shape
   `verify-sources.ts` already uses for STORM). Validation runs the actual
   `mermaid` package's parser via a jsdom shim — ported from
   datacrew-site's `lib/mermaid-validate.ts`, which had never been wired in
   because Cloudflare Workers' edge runtime can't run jsdom. Trigger.dev
   tasks are plain Node, so this finally runs for real: confirmed live,
   correctly accepting well-formed flowchart/sequence/erDiagram text and
   rejecting an unescaped-quote-in-a-label diagram (the literal production
   bug datacrew-site#218 started from) and garbage input outright.

   If every stateless attempt still fails and the caller passed a
   `conversation_id`, one last attempt escalates to the user's own live
   mermaid Conversation via `conversationSend` — the "Letta steered
   workflow" half of the original ask: the stateful, user-facing agent
   becomes a real fallback tier instead of just holding chat history.

   The result always returns the last attempt's diagram text plus a `valid`
   flag — never withheld, so there's something to show the user even on
   failure, but never silently trusted either.

## What's deliberately not done yet

- **Not deployed.** No `TRIGGER_PROJECT_REF` secret change needed (this
  project's existing one covers it) and no new Infisical secrets (reuses
  `LETTA_API_KEY`, already synced) — deploying is a mechanical next step,
  not a design one.
- **Not wired to datacrew-site.** The website's `/api/mermaid/generate`
  route is untouched. Calling this pipeline from the site needs its own
  design pass: this pipeline runs several LLM calls end-to-end (likely
  seconds, not the ~1s a single completion takes), so a synchronous
  request/response route is the wrong shape — the site would trigger the
  run and subscribe to it (`trigger-realtime-and-frontend`), the same way
  any other multi-step Trigger.dev run reaches a frontend in this repo.
- **`LOW_CONFIDENCE_THRESHOLD` is a guess, not a tuned value** — revisit once
  the eval harness (datacrew-site's Playwright-driven scoring script) runs
  against this pipeline instead of the old one-shot/prose-distillation
  paths.
- **No delivery fan-out.** This isn't a research→delivery composition
  (ADR-002) — there's no destination to fan out to, the seam's output IS
  what the caller wants back. Matches how `pattern-hunter-research` is
  triggerable standalone without `pattern-hunter-deliver`.

## Related

- datacrew-site#217, #218 — the design threads this build answers.
- `docs/ADR-001-project-boundaries.md`, `docs/ADR-002-research-seam-delivery-composition.md`.
- `docs/watchdog-rework.md`, `docs/storm-research-rework.md`,
  `executive-assistant/docs/morning-brief-rework.md` — the sibling
  composition-rework docs this one sits alongside.
