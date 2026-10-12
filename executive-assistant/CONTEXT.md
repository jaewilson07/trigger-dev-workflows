# executive-assistant — CONTEXT.md

Glossary for the **agentic-rss-feed** system (the factory intake line), locked
2026-10-12. Aligned with mdrag's `CONTEXT.md`: mdrag terms are reused with
mdrag's meanings (ADR 0022 discipline), and terms mdrag retired or defined
differently are deliberately avoided. snake_case for keys (feeds.yaml, state
table); prose form in docs.

The chain:

**Feed → Monitor → Feed_Item → Source → Item_Concept → Concept_Proposal →
Project → Proposal (filed issue) → Triage → work**

## Terms

**agentic-rss-feed**:
The system itself: a weekly Sweep over the Feed Registry that turns new content
into triaged work. It *consumes* feeds; it does not produce one. (Name is a
handle, not a description — Jae's pick, intake-not-output caveat recorded in
ADR 0009.)

**Feed**:
A watched source of content: a YouTube channel, a vendor changelog, a GitHub
repo, a subreddit. One row in the Feed Registry.
_Avoid_: Source (an mdrag harvested Document — different thing), Signal
(retired mdrag term, ADR 0017).

**Feed Registry**:
`feeds.yaml` — the declarative list of Feeds: name, provider type, config
(channel ID / repo / feed URL), optional cron override. Never holds state.
Adding a Feed is a PR that adds a row.

**Monitor**:
The per-Provider adapter that polls a Feed and detects new Feed_Items. Owns
three things: how to poll, the watermark shape, the ingest path. An RSS core
with provider specializations (YouTube channels and GitHub commits/releases
are RSS/atom feeds at the front).

**Feed_Item**:
One new piece of detected content, pre-ingest. RSS's "Item".

**Source**:
A Feed_Item after mdrag ingestion — mdrag's harvested Document subtype
(ADR 0041). Transcripts come through `readings/save`.

**Watermark**:
The per-Feed cursor (video ID + date, commit SHA, GUID/date+hash) stored in the
state table. The never-re-poll guarantee.

**Item_Concept**:
An extracted idea, persisted as an mdrag **Annotation** on the Source, with
AnnotationSupport. Never a standalone document.

**AnnotationSupport**:
The evidence backlink on an Item_Concept: verbatim quotation + locator
(timestamp). Counting supports across distinct Feeds is how Recurrence is
measured — a query over edges, not a counter.

**Concept_Proposal**:
The deduplicated proposal entity. Semantic matching target: an Item_Concept
that matches an existing Concept_Proposal adds a support edge instead of
creating a new one. Carries an action type and a status
(new/filed/parked/rejected).

**Action type**:
What a Concept_Proposal asks for: `extend-codebase` | `write-content` |
`update-skill` | `refresh-research`. Issue templates key off it.

**Project**:
A unit of ongoing work, held **1:1:1** as an mdrag doc ↔ a Paperclip project ↔
a Slack thread, created together through one write path (📎-intake). mdrag owns
the what/why (scope note — the highest-leverage field in the system); Paperclip
owns status and tasks; the Slack thread is the activity feed.

**📎-intake (manual intake)**:
The bot-layer flow triggered by a 📎 reaction on any Slack message:
`reaction_added` (code, not agent memory) → owning agent DMs for context →
semantic dedup check against existing Projects → mdrag doc + Paperclip project
+ Slack thread created and cross-linked → conversation saved with
`content_class: "transcript"` → ✅ stamped on the original message (receipt and
idempotency guard).

**Proposal (filed)**:
The GitHub issue manifestation of a Concept_Proposal: `proposed-by-ai` label,
action type, filed to the Project's repo or `factory-inbox`.

**Triage**:
The weekly human gate: strip the label (accept) or close (reject). Decisions
recorded per Feed as calibration data for any future auto-promotion.

**Sweep**:
The weekly run (Friday-aligned): poll → ingest → extract → match → file →
notify. Deliberate reuse of mdrag's maintenance-pass term. Per-feed cron
overrides inherit it by default.

**State table**:
Scanner-side bookkeeping: watermarks, issue links, Concept_Proposal status.
mdrag is the memory; the table is the ledger.

**Recurrence**:
A Concept_Proposal gathering AnnotationSupports from distinct Feeds — the
trend signal. "This keeps coming up."

**factory-inbox**:
The fallback repo for Proposals whose Project records no repo.
