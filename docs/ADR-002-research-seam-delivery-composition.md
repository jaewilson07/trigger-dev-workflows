# ADR-002: Workflows compose as research → seam → delivery, with a shared status vocabulary

**Status:** Accepted (2026-08-05); this record written 2026-08-12
**Decider:** jaewilson07

## Context

By 2026-08-05 every workflow in this repo had grown the same shape of problem,
independently, in five different files. An audit of all five (`docs/*-rework.md`,
`executive-assistant/docs/morning-brief-rework.md`) found the same defects
recurring under different names:

- **Research and delivery welded together.** `morning-brief.ts` was one linear
  chain (`fetch-emails → triage-emails → search-topics → synthesize-brief →
  post-slack → log-activity`); a weekly digest wanting the same research would
  have had to re-implement the first three steps or throw away the Slack post.
  Pattern Hunter's step 5 was called "Final Packaging" but delivered nothing —
  the finished report existed only as a run's return value. Deep Researcher, the
  most sophisticated research chain in the repo, had the same gap.
- **Single-destination by construction.** Adding a second or third destination
  meant either more sequential steps welded onto the same chain (so a Domo
  outage delayed the Slack post queued behind it) or a fan-out with nowhere to
  live.
- **`skipped` encoded as failure.** STORM's `skipped()` returned `{success:
  false, error: "skipped — no Slack channel"}}`, making "nobody configured
  Slack" indistinguishable from "Slack returned a 500".
- **One retry policy for unrelated failure modes.** Watchdog's monolith shelled
  out to the host, called three registries, and posted to Slack under one
  retry policy; a GitHub rate limit degraded the container check too.
- **Ad hoc reliability on the least reliable calls.** Email digest's Slack
  reply was a local `fetch` with no retry, called from three places, that threw
  out of the orchestrator and discarded an already-fetched, already-triaged
  digest.

Fixing each symptom locally would have re-derived a slightly different pattern
five times. The rework instead extracted one convention, first in
`morning-brief.ts` and then applied to Pattern Hunter, Deep Researcher, STORM,
Watchdog and Email Digest.

## Decision

**1. Every end-to-end workflow splits into an entry point, a research half, a
typed seam, and a delivery half:**

```
<workflow>-full-run             entry point: validate, seed metadata, sequence
├── <workflow>-research          steps → <Workflow>Research/Report   (knows no destination)
└── <workflow>-deliver(research) renders once, fans out              (knows no research)
      └── batch.triggerByTaskAndWait
            ├── output/report/deliver-slack
            ├── output/report/deliver-gdoc
            ├── output/report/deliver-notion
            └── output/report/deliver-mdrag  …
```

The seam type is **structured, not rendered** — `BriefResearch`,
`ResearchReport`, `StormResearch`, `InfraHealthReport` all carry data
(sections, citations, triage results, evidence), never a pre-rendered markdown
or Block Kit string. A destination needing a shape the seam doesn't emit (Domo
rows, Block Kit, a Notion database row) is a new task, never an edit to the
seam or to another destination's renderer. Each half is independently
triggerable: `brief-research` takes `{}`, `brief-deliver` takes any
`BriefResearch` "from anywhere" — this is what makes re-delivery of an
existing report a seconds-long call instead of re-running hours of research.

**2. Delivery fans out via `batch.triggerByTaskAndWait`, always at fixed
length.** Not `Promise.all` (unsupported around `triggerAndWait` in
Trigger.dev) and not a sequential `for` loop (serializes independent
destinations behind each other's latency/failures). The batch is always
every destination, never conditionally shortened — `triggerByTaskAndWait`
types results positionally, so a shortened array loses per-destination types.
An unconfigured or caller-disabled destination is triggered anyway and
returns `skipped`; the run history then records which destinations were live
each day, not just which ones the caller happened to ask for.

**3. Status vocabulary, repo-wide: `delivered | skipped | failed`.**
`skipped` is a RESULT, not an error — an unconfigured destination is the
normal state of a fresh checkout. Only a genuine failure throws, where
Trigger.dev's retry applies; the delivery orchestrator records the failure
without taking down its siblings — one destination's exception never costs
the others (`Promise.allSettled`-shaped semantics via the batch primitive,
not literal `Promise.allSettled`). Constructors (`outputDelivered()` /
`outputSkipped()` / `outputFailed()`, or the project-local equivalent) exist
so the fields cannot drift apart from the type. `success`/`status ===
"delivered"` is kept in sync where a separate live consumer (e.g. the
datacrew Slack bot) already reads a boolean.

**4. The vocabulary and delivery types are declared per project, copied —
not shared via relative import.** `executive-assistant`, `storm-research`,
`watchdog` are three separate Trigger.dev projects, each with its own
`package.json`/`trigger.config.ts`, deployed as independent artifacts.
`lib/report-delivery.ts` / `lib/brief-delivery.ts` (executive-assistant),
`lib/storm-types.ts` (storm-research), `src/lib/infra-delivery.ts` (watchdog)
declare the same three-state vocabulary independently. `lib/notion.ts` and
`lib/google-docs.ts` are each triplicated the same way. This is accepted debt,
not an oversight: a real shared package (`packages/shared` already exists for
Infisical helpers and the build extension, per `docs/ADR-001`) is the
eventual fix, but the identical vocabulary across all three copies is exactly
what that package would formalize when it's worth the migration. Until then,
copying a verified-against-live-credentials implementation (Drive, Notion)
beats maintaining a second, worse one per project.

**5. Within one project, a genuinely shared destination is imported, not
copied.** `report-deliver` (Slack/Drive/mdrag) is shared verbatim between
Pattern Hunter and Deep Researcher inside `executive-assistant` — both
produce `ResearchReport.steps: PatternHunterStep[]`, a type made
workflow-agnostic specifically so the second workflow could reuse the first's
delivery for free (datacrew#332 → #336). A shared seam is the trigger for
sharing delivery; two workflows that don't share a seam shape (e.g. Email
Digest's markdown-and-ephemeral-URL vs. the multi-step `ResearchReport`) get
their own delivery task rather than a generic `BriefDeliveryBase<T>` — see
"Alternatives considered."

**6. A third shared-function category, added later: conversation
resolution.** `mdrag-conversation-resolver.ts` (`executive-assistant/lib/`)
resolves-or-creates an mdrag Conversation (and its Letta agent) by
`(user_email, external_ref)`, shared today by Pattern Hunter and, as of
mdrag#1026/PR #52-#53 (2026-08-12), STORM's synthesis step. It sits alongside
the research-provider category (`mdrag-search-providers.ts`,
`deep-research-query.ts`) and the ingest/delivery category above as a third
kind of function a new research workflow can lean on rather than
reimplementing: *research providers* answer "find evidence", *ingest/delivery*
answer "where does the output go", *conversation resolution* answers "which
LLM identity does this run's writing calls belong to, and can the user
resume it." Not every workflow needs it — perspective discovery and interview
rounds in STORM stay parallel and unrouted deliberately (routing them through
one conversation would force sequential execution) — so it is opt-in per
LLM call, not a wrapper every workflow must adopt.

## Alternatives considered

- **A generic `BriefDeliveryBase<T>` seam** (Pattern Hunter audit R1)
  so one delivery implementation serves every workflow. Rejected: it works
  for Google Docs (always wants markdown) but not for Slack, which needs to
  destructure a concrete `T` — `deliver-slack` builds Block Kit from
  `BriefResearch.triageResults`, `report-slack` builds it from
  `ResearchReport.steps`, and neither can read the other's payload. One
  generic seam whose destinations secretly only accept one concrete shape is
  worse than two honest, differently-typed seams that share only the
  vocabulary.
- **Forcing Email Digest through `report-deliver`.** Rejected: a digest has
  no `steps`, only a markdown body and a Slack `response_url`; inventing a
  fake step list so the shared renderer could ignore it was worse than a
  second small delivery task that shares the vocabulary but not the seam.
- **Restructuring an entry point to reach its halves through a one-entry
  batch**, floated as a workaround while the bot-gate blocker below was still
  live. Rejected: it contorts correct composition to dodge a misconfigured
  WAF, and the contortion would outlive the misconfiguration (it did — see
  Addendum).

## Consequences

- Adding a fifth destination (Notion) to four workflows across all three
  projects cost one library-per-project, three thin tasks, and one entry per
  fan-out, with **no research code touched** — `docs/notion-delivery.md`'s
  worked example of what this decision bought.
- A destination failing never costs a sibling destination or discards
  completed research — verified live for Pattern Hunter (a failed research
  step still delivered a partial Google Doc), Deep Researcher, Email Digest,
  and Watchdog.
- New workflows get a checklist instead of a blank page: pick (or write) a
  seam type, write research knowing no destination, write delivery as a
  fixed-length batch, return `delivered | skipped | failed`.
- The "copied, not imported" tri-plication (§4) means a bug fixed in one
  project's `lib/notion.ts` does not propagate to the other two automatically
  — each copy needs its own fix, verified separately. Accepted until a real
  shared package is worth the migration cost.
- This ADR does not change project boundaries (`docs/ADR-001`) or govern
  which Trigger.dev project a task's code lives in — that's a separate axis.

## Addendum (2026-08-12)

Three of the source rework docs (`docs/storm-research-rework.md`,
`docs/watchdog-rework.md`) recorded their entry points (`storm-research-full-run`,
`infrastructure-health-report`) as **blocked** from reaching their own children:
a bot-gate in front of `triggers.datacrew.space` demanded a Turnstile challenge
on `POST /api/v1/tasks/{id}/trigger` (a single `triggerAndWait`) unless the
caller's key matched one hardcoded allowlist entry — `executive-assistant`'s.
`batch.triggerByTaskAndWait` calls (`POST /api/v1/tasks/batch`) were never
matched by the gate rule, which is why every project's delivery fan-outs
worked while `storm-research`'s and `watchdog`'s single-child entry points
403'd.

**This is fixed** (`infra-bonker@ee5cdd0`, 2026-08-07 — see this repo's own
`AGENTS.md` → "Invoking these tasks from outside" for the live-verified
detail): the gate now validates the presented key live against
`GET /api/v1/whoami` instead of string-comparing it to one hardcoded value, so
any project's real secret key clears it. Both previously-blocked rework docs
still described the pre-fix state as current as of this ADR being written;
they have been corrected in place to point here rather than re-describing the
fix.

`storm-research-full-run` — the entry point this fix unblocked — was
subsequently exercised end-to-end (not just unblocked-in-principle) by
mdrag#1026 / trigger-dev-workflows#50 / #51 (PRs #52, #53, 2026-08-12), which
added per-source mdrag ingestion and conversation-routed synthesis on top of
the composition this ADR describes, without changing the composition itself.

## Related

- `docs/hub/README.md` — why this is an ADR (a decision record, historically
  accurate) rather than a `docs/hub/` explainer (current-state, edited in
  place). `AGENTS.md`'s "Composition conventions" section is the
  always-current rule summary this ADR is the reasoning behind — mirroring
  how `docs/ADR-001` backs "Project boundaries."
- `executive-assistant/docs/morning-brief-rework.md` — origin of the pattern.
- `docs/pattern-hunter-rework.md`, `docs/deep-researcher-rework.md`,
  `docs/email-digest-rework.md`, `docs/storm-research-rework.md`,
  `docs/watchdog-rework.md` — the five applications, each with its own
  worked decisions and live verification.
- `docs/notion-delivery.md` — the "what this decision bought" worked example.
- `docs/ADR-001-project-boundaries.md` — the orthogonal decision (which
  project a task's code lives in) this ADR does not govern.
