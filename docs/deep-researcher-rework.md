# Deep Researcher composition rework

**Status:** implemented, deployed (`executive-assistant` 20260805.2), verified live end-to-end
**Date:** 2026-08-05
**Audit finding:** PARTIAL — "the most sophisticated research workflow, and again: no delivery"

## The problem

Deep Researcher's research composition needed nothing. A recursive fan-out where each level
is its own task self-triggering into level+1, each query within a level is its own task, each
of the four mdrag primitives per query is its own reusable task, cost bounded before any call
is made, per-branch failure tolerance, and the `metadata.root` vs `metadata.parent`
distinction already correct and explained.

The final report was synthesized inline and landed in `reportStep.narrative`. Nothing posted
it, filed it, or ingested it.

## The change

This rework is deliberately the smallest of the five: **the research chain is untouched.**
What was added is a delivery half and one call to it.

```
deep-researcher-full-run             (unchanged: clamp, recurse, synthesize the final report)
├── deep-research-level              (unchanged, recursive)
├── mdrag-synthesize                 (unchanged)
└── deep-researcher-deliver          NEW — adapter → ResearchReport
    └── report-deliver               shared with Pattern Hunter
        ├── report-slack
        ├── report-gdoc
        └── report-mdrag
```

## Why the adapter is nine lines of mapping

`deep-researcher-full-run` already returns `WorkflowRunResult<DeepResearcherPayload>` —
`steps: PatternHunterStep[]`, one per recursion level plus a Final Report step whose
`narrative` holds the synthesized prose, with each level's search hits as `EvidenceResult`
items carrying real source URLs.

`ResearchReport.steps` is typed to exactly that. So the seam needed no new shape and no new
renderer: `lib/render-report.ts` turns a level's evidence into cited bullets and the Final
Report's narrative into prose without knowing which workflow produced either.

That is datacrew#332 paying off a second time. `WorkflowRunResult` and `PatternHunterStep`
were made workflow-agnostic *specifically* so #336 could reuse them, and `narrative` was
added to `PatternHunterStep` because #332 anticipated "the future Deep Researcher workflow,
whose steps are prose-first rather than item-list-first". The delivery half inherited both
decisions for free. The audit's read — that these two workflows had "the harder half done" —
was right.

## Decisions worth defending

**Delivery does not affect `status`.** `status` stays a statement about the RESEARCH. A Slack
outage does not make a completed depth-3 recursion a failed run. Same call `morning-brief.ts`
makes.

**`deliveries` is present on every return path**, including the level-1-failed branch, where
it is a single `skipped` entry reading `"level 1 failed — no report to deliver"`. A reader
never has to guess whether delivery ran and found nothing or never ran at all.

**A delivery task that dies outright is caught, not propagated.** By the time delivery runs,
the recursion has spent its whole mdrag primitive budget. Losing that to a `triggerAndWait`
rejection would be the exact failure mode this rework exists to prevent, so `deliver()`
catches and returns a `failed` entry.

**`metadata.set("status", "completed")` moved to after delivery.** Previously the envelope
flipped to `completed` before the final step was appended. Now the run is only advertised as
complete once delivery has finished, so a subscriber does not see "completed" while
destinations are still in flight.

**`delivery.enabled === false` short-circuits without triggering the delivery task**, rather
than triggering it and letting all three destinations report `skipped`. This is the one case
where not-running is genuinely cheaper — it skips a whole nested run — and the returned shape
is identical either way, so callers never branch on it.

## Verification

Triggered live against `triggers.datacrew.space` with `{topic, depth: 1, breadth: 1}`
(run `run_cmsfo87fj002w4ilaazeb9w01`):

```
deep-researcher-full-run       COMPLETED
├── deep-research-level        COMPLETED  (1 query · 5 sources searched, 1 kept · 6 learnings)
├── mdrag-synthesize           COMPLETED  (final report narrative)
└── deep-researcher-deliver    COMPLETED
    deliveries: slack  skipped   "disabled by caller"
                gdoc   delivered https://docs.google.com/document/d/1jtRDEWc43NJc1aj8h…
                mdrag  skipped   "disabled by caller"
```

This is the fully-exercised path of the five reworks: **real research** (a live mdrag
`search-providers` call returning a real source URL, a real critique pass, a real synthesis)
producing a **real Google Doc** with the evidence rendered as cited bullets and both step
narratives as prose. The steps arrived with genuine content — a
`digitalapplied.com` citation with a verbatim quote, and a synthesis narrative that correctly
noted the single verified claim did not actually answer the research question.

## Not verified

- **Depth > 1.** The test ran `depth: 1, breadth: 1` to keep the run short. The recursion
  itself is untouched by this rework, and `allSteps` — which delivery consumes — is
  assembled by `deep-research-level` exactly as before.
- **Slack and mdrag destinations**, disabled for the same reason as in the Pattern Hunter
  test: a smoke test should not post to a real channel or write to a real wiki.

---

## Since: Notion (2026-08-05)

A Notion destination was added to every workflow in the repo — see
`docs/notion-delivery.md`. Deep Researcher gained it for free, because `report-deliver` is shared: the only
change here was forwarding an optional `notion` override through
`deep-researcher-full-run` → `deep-researcher-deliver` → `report-deliver`, whose
batch went from three entries to four.

The point worth recording here is the cost: adding a destination that reaches four
workflows took one library, three thin tasks, and one entry per fan-out, with no
research code touched. That is what the split in this document was for.
