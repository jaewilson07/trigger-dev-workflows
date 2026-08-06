# Pattern Hunter composition rework

**Status:** implemented, deployed (`executive-assistant` 20260805.2), delivery verified live
**Date:** 2026-08-05
**Reference pattern:** `executive-assistant/docs/morning-brief-rework.md`
**Audit finding:** PARTIAL — "research composition without delivery composition, plus a
delivery task with no workflow to be composed into"

## The problem

Pattern Hunter had the strongest research decomposition in the repo — five steps, each its
own task with its own retry and its own live-metadata publication — and **no delivery half
at all**. Step 5 is "Final Packaging": it packages, it does not deliver. The finished report
existed only as the run's return value and its live metadata, consumed by a frontend
subscription.

Meanwhile `pattern-hunter-publish-gdoc` — a correctly-shaped destination task that already
returned `consent_required` as a result rather than throwing — was **orphaned**:
browser-triggered only, chained from no orchestrator.

## The split

```
pattern-hunter-full-run          entry point: validate, seed metadata, sequence (≈200 lines,
│                                 most of it doc comment)
├── pattern-hunter-research      steps 1-5 → PatternHunterReport (knows no destination)
│   ├── pattern-hunter-context-snapshot
│   ├── pattern-hunter-pain-points
│   ├── pattern-hunter-hypotheses
│   ├── pattern-hunter-red-team
│   └── pattern-hunter-brief
└── pattern-hunter-deliver       adapter → ResearchReport
    ├── report-deliver           batch.triggerByTaskAndWait, 3 entries
    │   ├── report-slack
    │   ├── report-gdoc
    │   └── report-mdrag
    └── pattern-hunter-publish-gdoc   the orphan, folded in as a 4th destination
```

## The seam: `ResearchReport`, and why it is a second seam

`lib/report-delivery.ts` defines `ResearchReport` — structured, not rendered:

```ts
{ workflow, title, subject, date, generated_at, status, steps: PatternHunterStep[], ownerEmail? }
```

The audit's R1 suggested making `BriefDeliveryBase` generic in its payload
(`BriefDeliveryBase<T>`) so the existing `deliver-*` tasks would serve any workflow. **That
was rejected**, and the reason is worth recording: it works for Google Docs, which only ever
wants markdown, but not for the other two brief destinations. `deliver-slack` builds Block
Kit out of `TriageResult[]` and `TopicSearchResult[]`; `deliver-domo-canvas` flattens the
same into dataset rows. A `BriefDeliveryBase<T>` would have left both of them unable to
destructure a `T` they know nothing about. One generic seam whose destinations secretly
accept only one shape is worse than two honest seams.

What the two seams *do* share is the vocabulary — `delivered | skipped | failed`, where a
well-formed refusal is a result and not a crash — deliberately identical so a future shared
package can merge them without re-litigating the statuses.

`steps: PatternHunterStep[]` is the right structure to carry because **Deep Researcher
already produces exactly it**. That is not a coincidence: `WorkflowRunResult`/
`PatternHunterStep` were made workflow-agnostic by datacrew#332 specifically so #336 could
reuse them. The delivery half inherits that generality for free — `lib/render-report.ts`
renders a step's `narrative` as prose and its `items` as cited bullets without knowing which
workflow produced them.

## Decisions worth defending

**`metadata.parent` → `metadata.root` in all five node tasks.** This is the one behavioural
change to existing code, and skipping it would have been a silent regression. The five tasks
published their finished step via `metadata.parent.append`, correct while
`pattern-hunter-full-run` *was* their parent. After the split their parent is
`pattern-hunter-research`, an intermediate run nobody subscribes to, so `.parent` would have
written live progress into a run no frontend was watching — the report would still be
correct and the step-reveal UI would silently stop updating. `.root` resolves to
`pattern-hunter-full-run` when nested and to `pattern-hunter-research` when that task is
triggered standalone; both are the run a viewer subscribed to. This is precisely the
distinction `tasks/deep-research-level.ts` already documents at length for its recursion.

**The orphan is wrapped, not replaced.** `pattern-hunter-publish-gdoc` runs *after* the
three-entry batch rather than inside it, because it publishes to the **end user's** Drive via
Pattern Hunter's consent dance, while `report-gdoc` publishes to the **workflow owner's**
Drive with a stored service token. Different Drive, different identity, different failure
mode: `consent_required` is a legitimate terminal answer for a human clicking a button and a
silent stoppage for a scheduled job. Folding it into the same batch would have forced one of
those behaviours onto the other. It stays browser-triggerable — that is a real use case, and
the multi-use-token reasoning in its own docstring is sound.

**Delivery is off by default.** Every destination reads its own env
(`REPORT_SLACK_CHANNEL`, `REPORT_MDRAG_COLLECTION_ID`, `MORNING_BRIEF_GOOGLE_OWNER_EMAIL`)
and reports `skipped` when unconfigured. An existing caller triggering
`pattern-hunter-full-run` with an unchanged payload gets the same report plus three
`skipped` entries — not an error, and not a surprise Slack post.

**`PatternHunterFullRunResult` keeps its shape.** `report` is still mdrag's exact wire
contract so `wiki.datacrew.space/pattern-hunter` keeps working; `deliveries` and
`publishGDoc` are added *alongside*, never inside `report`.

**A failed destination does not fail the run.** The research succeeded and is on the output;
throwing would discard it and retry the whole Letta chain. Logged at `error`, and the entry
point warns separately if *nothing* landed.

## Verification

Triggered live against `triggers.datacrew.space` (run `run_cmsfo73xx00274ilaa3sv1xhd`):

```
pattern-hunter-full-run          COMPLETED
├── pattern-hunter-research      COMPLETED  → status "failed" (see below)
└── pattern-hunter-deliver       COMPLETED
    deliveries: slack  skipped   "disabled by caller"
                gdoc   delivered https://docs.google.com/document/d/1sxeji28v7uPaM2SC…
                mdrag  skipped   "disabled by caller"
    publishGDoc: skipped "no publishGDoc.user_id"
```

**The research half failed and the Google Doc was still delivered.** That is the rework
working, not a flaw in the test: `pattern-hunter-context-snapshot` returned `fetch failed`
because `PATTERN_HUNTER_URL` is not set in this Trigger.dev project, so Pattern Hunter's
internal-only FastAPI service is unreachable from the runner. The partial report — one
failed step, with its error text — was rendered and published anyway, which is exactly the
failure isolation the split exists to provide. Before the rework a run in this state produced
nothing anyone could read.

## Not verified

- **A successful research run.** Needs `PATTERN_HUNTER_URL` on the
  `executive-assistant` project pointing at the reachable Pattern Hunter service. Nothing
  about the composition depends on it; the same delivery path ran on a partial report.
- **Slack and mdrag destinations** were deliberately disabled for the test run (a real
  channel post and a real wiki write are not appropriate side effects of a smoke test).
  `report-slack` is a thin adapter over `post-slack`, which is exercised daily by the
  morning brief; `report-mdrag` needs `REPORT_MDRAG_COLLECTION_ID` set before it can do
  anything but `skipped`.
- **`pattern-hunter-publish-gdoc` as a chained destination** — reached only when the caller
  supplies `publishGDoc.user_id`, and it needs `PATTERN_HUNTER_PUBLISH_API_KEY`.

---

## Since: Notion (2026-08-05)

A Notion destination was added to every workflow in the repo — see
`docs/notion-delivery.md`. Pattern Hunter gained it for free, because `report-deliver` is shared: the only
change here was forwarding an optional `notion` override through
`pattern-hunter-full-run` → `pattern-hunter-deliver` → `report-deliver`, whose
batch went from three entries to four.

The point worth recording here is the cost: adding a destination that reaches four
workflows took one library, three thin tasks, and one entry per fan-out, with no
research code touched. That is what the split in this document was for.
