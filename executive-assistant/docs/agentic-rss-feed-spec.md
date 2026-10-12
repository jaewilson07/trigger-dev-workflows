# Spec: agentic-rss-feed — the factory intake line

> Produced via Matt Pocock's `to-spec` skill from the grill-with-docs session of 2026-10-12
> (IdrisBot ↔ Jae, Slack DM). Eight decisions, locked vocabulary, one seam.

## Problem Statement

Jae's research inputs keep growing — Cole Medin's weekly YouTube videos and repos,
changelogs for repos DataCrew already watches, LiveKit and Domo release news —
but nothing connects "interesting idea seen" to "work that happens." Insights
evaporate in watch-later lists. Projects get lost (his words: "I always lose
projects"). Ideas that match active work never become work. Meanwhile the three
agents (IdrisBot, EmmaBot, DataCrew) track projects inconsistently, because
tracking depends on Jae remembering to ask — and memory-file rules get
compacted away, drowned by busy sessions, and drift with personality.

## Solution

**agentic-rss-feed**: a weekly **Sweep** — a trigger.dev scheduled task in the
executive-assistant project — that loops a **Feed Registry** (`feeds.yaml`),
detects new **Feed_Items** via per-provider **Monitors**, ingests them into
mdrag as **Sources**, extracts **Item_Concepts** stored as mdrag **Annotations**
with AnnotationSupport backlinks (verbatim quote + timestamp locator), matches
them against existing **Concept_Proposals** (semantic dedup; recurrence is the
AnnotationSupport edge count), crosslinks surviving proposals to **Projects**
(each kept 1:1:1 across mdrag ↔ Paperclip ↔ Slack thread), and files
`proposed-by-ai` GitHub issues — per-repo with a `factory-inbox` fallback,
carrying an action type. Jae triages weekly: strip the label to accept, close
to reject. A 📎 reaction on any Slack message gives *manual* intake the same
path, triggered at the bot layer (deterministic code, not agent memory).

## User Stories

1. As Jae, I want new Cole Medin videos detected automatically each week, so that I never miss one.
2. As Jae, I want every detected video ingested into mdrag with its full transcript, so that it's RAG-queryable forever.
3. As Jae, I want concepts extracted from each video and stored as Annotations citing the exact transcript quote and timestamp, so that any proposal can be walked back to the moment that inspired it.
4. As Jae, I want the same idea seen twice (same video re-processed, or re-explained in a later video) to merge into one Concept_Proposal, so that the tracker isn't full of duplicates.
5. As Jae, I want a concept seen from multiple distinct Feeds to surface with "this keeps coming up," so that trends become visible.
6. As Jae, I want concepts matched against my active projects, so that "extend crew-dcs for the new LiveKit feature" happens without me connecting the dots.
7. As Jae, I want matches to file GitHub issues automatically with a `proposed-by-ai` label, so that proposed work lands where work lives.
8. As Jae, I want proposals filed to the project's own repo when one is recorded, so that issue-agent-driver can pick them up where the code is.
9. As Jae, I want proposals for projects with no repo to land in a factory-inbox repo, so that nothing is dropped.
10. As Jae, I want each proposal to carry an action type (extend-codebase, write-content, update-skill, refresh-research), so that non-code work (blog posts, community answers) flows through the same engine.
11. As Jae, I want a weekly Slack summary of what was filed and what's awaiting triage (with the oldest item's age), so that triage becomes a Friday ritual and stale items are visible.
12. As Jae, I want to accept a proposal by stripping its label and reject by closing it, so that triage is two cheap moves.
13. As Jae, I want an @mention when awaiting-triage count exceeds 10, so that a quiet pile-up becomes impossible to ignore.
14. As Jae, I want to react 📎 to any Slack message to kick off project/idea capture, so that tracking never depends on me remembering to ask.
15. As Jae, I want the 📎 trigger handled by bot-layer code that can't forget, not by agent memory, so that all three agents behave identically.
16. As Jae, I want the agent to DM me for 2–3 fields (type, project, one-line why) after I 📎 something, so that capture takes ten seconds.
17. As Jae, I want a 📎'd conversation saved to mdrag as a Transcript (`content_class: "transcript"`), so that the discussion is preserved with the artifact.
18. As Jae, I want a ✅ reaction stamped on the original message when intake completes, so that I have a receipt and double-processing is impossible.
19. As Jae, I want every project to exist 1:1:1 as an mdrag doc, a Paperclip project, and a Slack thread, created together through one write path, so that projects can never be lost or drift apart.
20. As Jae, I want each project's Slack thread to be its activity feed (matches, filings, triage nags as replies), so that one scroll tells the project's whole story.
21. As Jae, I want new project ideas semantic-checked against existing projects at capture time ("80% like X — new or fold in?"), so that projects don't silently duplicate.
22. As Jae, I want the existing 12 Paperclip projects backfilled with scope notes and repo links, so that matching works for what already exists.
23. As Jae, I want the changelog monitors DataCrew already runs registered as Feeds instead of rebuilt, so that existing watching becomes actionable.
24. As Jae, I want to add a new feed by opening a PR that adds a row to feeds.yaml, so that new sources are config, not code.
25. As Jae, I want a new source *type* to require exactly one new Monitor adapter, so that extensibility has a known, bounded cost.
26. As Jae, I want per-feed cron overrides with a weekly default, so that a fast-moving subreddit can poll daily without touching the rest.
27. As Jae, I want watermark state stored outside feeds.yaml, so that the config file stays declarative and diff-clean.
28. As Jae, I want the Sweep aligned with DataCrew's existing Friday digest, so that all weekly review lands in one batch.
29. As Jae, I want parked concepts (no project match) retained in mdrag, so that they can match projects I start later.
30. As Jae, I want my weekly accept/reject decisions recorded per source, so that the data exists to justify auto-promotion later.
31. As the issue-agent-driver, I want proposals filed with the `ready-for-agent`-compatible shape once accepted, so that approved work can be implemented by agents.
32. As EmmaBot/DataCrew, I want the same paperclip-intake runbook symlinked into my skills, so that intake behavior is identical across all three agents.

## Implementation Decisions

**D1 — General framework, Cole as Feed #1.** The Feed Registry is generic; Cole
Medin's YouTube channel, `coleam00` GitHub, and `cole-medin-ai-coding` releases
are the first rows. Existing DataCrew changelog monitors get *registered*, not
rebuilt. LiveKit and Domo release news follow as rows.

**D2 — Auto-file with `proposed-by-ai` quarantine label.** No pre-filing
approval gate; the label is the gate. Weekly Slack triage summary (filed count,
awaiting count, oldest age); >10 awaiting triggers an @mention escalation.
Triage = strip label (accept) or close (reject). Accept/reject ratio per Feed
is recorded as the calibration data for any future auto-promotion.

**D3 — Project registry: mdrag upstream, Paperclip downstream, 📎-intake as the
only write path.** Project docs live in mdrag (scope note = highest-leverage
field); Paperclip is the work projection; each project also gets a Slack
thread (parent in a #projects channel) — 1:1:1, created together, IDs
cross-linked both ways. Field ownership: mdrag owns what/why, Paperclip owns
status/tasks. One-time backfill drafts scope notes for the existing 12
projects (only 1 has goals today).

**D4 — Item_Concept = mdrag Annotation, plus a thin state table.** Concepts are
Annotations (`document_type: "annotation"`) on the Source Document with
AnnotationSupport (quotation + locator). A thin scanner-side state table holds
watermarks, issue links, and status (new/filed/parked/rejected) — the
bookkeeping mdrag shouldn't carry. mdrag is the memory; the table is the
ledger.

**D5 — Monitor adapters; layered dedup.** Per-provider Monitors own: poll,
watermark shape, ingest path. youtube-channel (channel RSS; watermark = video
ID/date; first-run backfill via API/yt-dlp since RSS holds ~15 videos; ingest =
readings/save transcript), github (commit SHA/release timestamp; atom feeds or
API), rss/blog (GUID or date+hash; ingest/web), reddit (post ID). Dedup layers:
watermarks (never re-poll) → mdrag content-hash/source_url (identical content =
update, never Duplicate inside one Collection) → semantic match at the
Concept_Proposal level (same idea = new AnnotationSupport edge, not a new
proposal). Recurrence = support count across distinct Feeds — a query, not a
counter.

**D6 — Issue routing: per-repo with factory-inbox fallback; action types.**
Registry records each project's repo. Proposals file there (`proposed-by-ai`
label created in every target repo at setup); no repo → `factory-inbox` repo.
Every proposal carries an action type: `extend-codebase` | `write-content` |
`update-skill` | `refresh-research`; issue templates vary by type.

**D7 — Weekly Sweep, Friday-aligned.** One trigger.dev `schedules.task` cron in
executive-assistant (same pattern as morning-brief), composed stages: poll →
ingest → extract → match → file → notify. Runs just before DataCrew's existing
Friday digest (exact time verified at build — not found in code during the
session). Per-feed cron override supported; default inherits the weekly Sweep.

**D8 — Locked vocabulary (CONTEXT.md).** Feed → Monitor → Feed_Item → Source
(mdrag) → Item_Concept (Annotation + AnnotationSupport) → Concept_Proposal
(dedup + recurrence) → Project (1:1:1) → proposed-by-ai issue → Triage → work.
Aligned to mdrag's glossary: Source/Annotation/Transcript/Duplicate/Provider/
Job/Sweep reused with mdrag's meanings; "Signal" and bare "Source"-for-feed
deliberately avoided (retired `user_signals`; ADR 0017/0041). snake_case for
keys, prose form in docs.

**Feeds config.** `feeds.yaml`: name, provider type, config (channel ID / repo /
feed URL), optional cron override. Declarative only — watermarks live in the
state table.

**RSS is the archetype.** YouTube channels and GitHub commits/releases expose
RSS/atom feeds, so Monitors are an RSS core with provider-specific ingest
specializations.

**Reuse, don't rebuild.** `lib/mdrag-seen-articles.ts` (watermark prior art),
`lib/learn-annotations.ts` (annotation client), the research→deliver task
composition pattern, and the existing Slack bot (new `reaction_added`
subscription + `reactions:read` scope for 📎-intake).

**Test seam.** One seam, highest point: the effect clients (mdrag, GitHub,
Slack) behind fakes.

## Testing Decisions

A good test asserts external behavior only — what the system does at its
boundaries, never how it's wired inside.

- **The one seam**: fake mdrag, GitHub, and Slack clients. Drive the Sweep with
  fixture feed payloads (RSS XML, atom, channel feed JSON) and assert on effect
  calls: this Source ingested, that Item_Concept annotation written with these
  supports, this issue filed to that repo with that label and action type,
  these thread replies posted.
- **Pure units** (no seam needed): feeds.yaml parsing/validation, watermark
  cursor advance, dedup scoring thresholds, match-rationale shaping, action-type
  classification.
- **Prior art**: `lib/*.test.ts` and `tasks/research/*.test.ts` — compile with
  tsc then `node --test`. Same pattern, no new harness.

## Out of Scope

- Auto-promotion of proposals to accepted (graduation is evidence-gated and manual).
- Bidirectional Paperclip ↔ mdrag sync (one write path, one direction).
- YouTube visual-frame/slide extraction (readings/save is text-only).
- Project canvases in Slack (noted as a cheap later add; slackbot has canvas code).
- Any new source *type* beyond youtube-channel, github, rss, reddit.
- Producing an RSS feed (the name's known wart: this system consumes feeds).

## Further Notes

- **Name**: `agentic-rss-feed` (Jae's pick). Intake-vs-output caveat recorded;
  CONTEXT.md defines the term.
- **Setup checklist**: create `proposed-by-ai` label in every target repo;
  create `factory-inbox` repo; create #projects channel; add `reaction_added`
  subscription + `reactions:read` scope to the Slack app; verify DataCrew's
  Friday digest time.
- **Project Zero**: agentic-rss-feed itself, captured manually through the
  1:1:1 pattern (mdrag doc ↔ Paperclip project ↔ Slack thread) — the manual
  execution becomes the 📎-intake runbook's first draft.
- Full decision narrative: ADRs 0001–0008 alongside `CONTEXT.md` in
  `executive-assistant/docs/adr/`.
