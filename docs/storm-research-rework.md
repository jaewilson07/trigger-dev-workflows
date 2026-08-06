# STORM research composition rework

**Status:** implemented, deployed (`storm-research` 20260805.1), Google Doc destination
verified live; **full-chain run blocked by a bot-gate misconfiguration that predates this
work** — root cause found, fix is one infrastructure change (see "Blocked" below)
**Date:** 2026-08-05
**Audit finding:** PARTIAL (R2) — "this project *looks* like the pattern and is close, but
the split isn't made"

## The problem

Every stage was already its own task with its own retry, interviews fanned out via
`batchTriggerAndWait`, verification sharded ×6, and there was a real evaluator-optimizer
loop. Step 6 `prepare-report` explicitly delivered nothing and the four `output-*` tasks were
interchangeable. The docstring even called this "Composable outputs".

What was missing was the **seam**. Research (steps 1-5), rendering (6) and delivery (7) lived
in one 376-line task, so you could not re-deliver an existing briefing without re-running
hours of Letta interviews, and you could not run the research without the delivery loop being
part of the same run. `outputs` was a payload field, not a workflow.

## The split

```
storm-research-full-run       entry point: validate, seed metadata, sequence
├── storm-research            steps 1-5 incl. the evaluator-optimizer loop → StormResearch
│   ├── discover-perspectives
│   ├── conduct-interview ×N          (batchTriggerAndWait, unchanged)
│   ├── map-contradictions
│   ├── synthesize-report      ⇄      the optimizer
│   └── verify-sources ×6      ⇄      the evaluator
└── storm-deliver(research)
      prepare-report                   ← rendering moved BEHIND the seam
      └── batch.triggerByTaskAndWait   ← was a sequential `for` loop
            ├── output-slack-briefing
            ├── output-slack-md
            ├── output-google-doc
            └── output-mdrag-ingest
```

## The seam: `StormResearch`, structured not rendered

```ts
{ topic, report: SynthesizedReport, verification: VerificationReport,
  perspectiveCount, contradictionCount, revisionRounds, failedInterviewCount, researched_at }
```

The audit's R2c offered a choice: make the seam structured, or admit it is rendered and
document that. **Structured was chosen**, because the types already existed — `sections`,
`citations`, `verification`, `contradictions` are all in `lib/storm-types.ts` — so the only
work was moving the `prepare-report` call from the orchestrator into `storm-deliver`. A
destination that needs a shape `prepare-report` does not emit (Domo rows, Block Kit) is now a
new task rather than an edit to `prepare-report`.

The payoff is concrete rather than aesthetic. A STORM run is hours long: 5+ Letta interviews,
6 verification shards, up to 2 revision rounds. "The research succeeded but the Slack channel
was misconfigured" used to mean re-running all of it. It is now a seconds-long `storm-deliver`
trigger against a `StormResearch` — which `storm-research-full-run` now returns on its result
(`research`) precisely so you have one to re-trigger with.

## The three defects the missing seam was hiding (audit R2a/R2b/R2d)

**R2a — the fan-out was sequential.** Step 7 was a `for` loop of `await …triggerAndWait()`,
so a slow Slack file upload delayed the mdrag ingest behind it. It is now one
`batch.triggerByTaskAndWait` with the always-four-entries convention: results stay
positionally typed, and the run history records which destinations were live and why the
others were not.

**R2b — `skipped` was encoded as failure.** `skipped()` returned
`{ success: false, error: "skipped — no Slack channel" }`, making "nobody configured Slack"
indistinguishable from "Slack returned a 500". `OutputResult` now carries
`status: "delivered" | "skipped" | "failed"` plus `reason`/`error`, with
`outputDelivered()`/`outputSkipped()`/`outputFailed()` constructors so the fields cannot
drift.

**`success` is retained**, and that is deliberate rather than lazy: the datacrew slackbot
(`commands/research.py`) reads `success` off this workflow's returned `outputs[]`, and it is
a separate repo on its own deploy cycle. Dropping the field to save a line would break a live
consumer. It is now exactly `status === "delivered"`, computed in one place.

**R2d — stale docstring and hardcoded config.** The orchestrator called `output-google-doc` a
STUB; it was not. `output-mdrag-ingest` hardcoded its collection id and ingest URL; both now
read env (`MDRAG_COLLECTION_ID`, `MDRAG_URL`) and report `skipped` when unset rather than
silently writing into whichever wiki the constant named.

## `output-google-doc` rewritten (audit R5)

The old implementation drove the Drive + Docs REST APIs by hand: create an empty file, then
`documents.batchUpdate` with an `insertText` request. **`insertText` takes plain text**, so
every `#`, `**bold**` and `[1]` landed literally in the document — a bug its own TODO
acknowledged.

It now goes through `lib/google-docs.ts`, which uploads `text/markdown` and lets **Drive**
convert it into a native Doc. That file is a verbatim copy of
`executive-assistant/lib/google-docs.ts`, along with `lib/google-auth.ts`, and copying is a
deliberate choice with a stated cost: the two projects have separate `package.json` and
`trigger.config.ts` files and deploy independently, so sharing needs a real shared package —
work R5 scopes out. Copying the one Drive implementation that has been verified against live
credentials beats maintaining a third, worse one. This removes STORM's independent Google Doc
implementation, taking the repo from three to two.

`ownerEmail` is now preferred over `slackUserId`, because the auth service keys
`google_tokens` by `owner_email` and rejects platform-prefixed ids (infra-bonker#409).
`slackUserId` is still accepted, since the datacrew slackbot passes one.

## New env vars on `proj_wirdhbubjmhwu4r`

Set during this rework: `GOOGLE_TOKEN_API_KEY`, `DATACREW_API_TOKEN` (both from Infisical
`/`), `AUTH_SERVICE_URL`, `MDRAG_URL`, `STORM_GDOC_OWNER_EMAIL`. The project's
`syncEnvVars` extension already lists the first two but only runs when
`INFISICAL_CLIENT_ID`/`_SECRET` are present at deploy time, which they were not.

## Verification

**`output-google-doc`, live** (run `run_cmsfokdlx004c4ilayxar8oe9`):

```
STATUS: COMPLETED
{ destination: "google_doc", status: "delivered", success: true,
  url: "https://docs.google.com/document/d/1lpJ-TGMzth7gJtNezLs-ucF_SXEi1AP0fPpnyp5OtYY/edit" }
```

Markdown headings, bold and links converted into real Doc formatting — the bug the rewrite
targeted. Both the new `status` and the retained `success` are present and agree.

`prepare-report` also verified standalone (run `run_cmsfoke…`, COMPLETED) — the rendering
behind the seam is unchanged.

## Blocked: `storm-deliver` and `storm-research-full-run` cannot run

Both fail immediately with:

```
TriggerApiError: 403 status code (no body)
  at _doZodFetchWithRetries (@trigger.dev/core/src/v3/apiClient/core.ts:252)
```

**This predates the rework.** The two `storm-research-full-run` runs on record — 2026-08-03
22:21 and 2026-08-05 04:38, both on the pre-rework monolithic code — failed with the
byte-for-byte identical error. No storm run in this project's history has ever created a
child run.

### Root cause: the bot-gate's Bearer bypass is allowlisted per API key

The gate in front of `triggers.datacrew.space` (`homeserver/services/auth/gate_router.py`,
described in this repo's own `AGENTS.md`) intercepts `POST /api/v1/tasks/*/trigger` and
demands a Turnstile token. `AGENTS.md` states that callers presenting
`Authorization: Bearer …` are exempt by design. **That exemption is keyed to specific API
key values, not to "any valid Bearer token."** Measured directly against the public URL:

| Request | Result |
| --- | --- |
| `POST /api/v1/tasks/email-digest/trigger`, EA prod key | `200` |
| `POST /api/v1/tasks/morning-brief/trigger`, EA prod key | `200` |
| `POST /api/v1/tasks/pattern-hunter-full-run/trigger`, EA prod key | `200` |
| `POST /api/v1/tasks/check-cli-drift/trigger`, **watchdog** prod key | `403 {"detail":"missing Turnstile token"}` |
| `POST /api/v1/tasks/{id}/trigger`, **storm** prod key | `403 {"detail":"missing Turnstile token"}` |
| `POST /api/v1/tasks/batch`, any key | reaches the app (Trigger.dev's own auth response) |

Every task identifier behaves the same for a given key, and the User-Agent makes no
difference — so it is the **token**, not the path or the client.

That explains the whole pattern precisely:

- A run's `triggerAndWait` (single child) calls `/api/v1/tasks/{id}/trigger` with its own
  project's key. For `executive-assistant` that key is allowlisted, so its runs spawn
  children normally. For `storm-research` and `watchdog` it is not, so they 403.
- A run's `batch.triggerByTaskAndWait` calls `/api/v1/tasks/batch`, which the gate rule does
  not match — which is why `infra-health-research` and `infra-health-deliver` (both pure
  batch fan-outs) run fine in `watchdog` while its entry point, which uses a single
  `triggerAndWait`, does not.
- The SDK reports "no body" because it does not surface the gate's JSON on a 403.

### The fix (infrastructure, not code)

Add the `storm-research` and `watchdog` prod secret keys to the gate's Bearer allowlist, or
— better, and what `AGENTS.md` already claims — exempt `/api/v1/tasks/*/trigger` for any
request carrying an `Authorization: Bearer` header, letting Trigger.dev's own auth reject
bad keys. This is a change to `homeserver`, outside this repo, with security implications,
so it was **not** made here.

Worth flagging separately: this also means any external caller using a key other than
`executive-assistant`'s cannot trigger tasks through the public URL at all — including the
`storm-research` integration in the datacrew Slack bot.

The rework itself is structurally complete, typechecks clean, and is deployed. The moment
that allowlist is fixed, `storm-research-full-run` will run end to end.

## Not verified

- The full `storm-research-full-run` chain, the `storm-deliver` fan-out, and the
  evaluator-optimizer loop under the new split — all blocked above.
- Slack and mdrag destinations (would post to a real channel / write to a real wiki).

---

## Since: Notion (2026-08-05)

A Notion destination was added to every workflow in the repo — see
`docs/notion-delivery.md`. `storm-deliver`'s batch went from four entries to five, plus one new
`tasks/output-notion.ts`. `notion` is in `DEFAULT_OUTPUTS` for the same reason
`mdrag` is: it is addressed entirely by environment and reports `skipped` when
that is absent, so listing it costs nothing on a deployment with no Notion.

The point worth recording here is the cost: adding a destination that reaches four
workflows took one library, three thin tasks, and one entry per fan-out, with no
research code touched. That is what the split in this document was for.
