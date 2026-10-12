# ADR 0005: Per-provider Monitor adapters; layered dedup; recurrence via support edges

Status: accepted (2026-10-12)

## Context

"Monitor Cole's channel" is a special case of "monitor YouTube." Each source
type has a native watermark and ingest path. Dedup has two distinct targets:
content (already processed?) and concepts (already extracted?). mdrag gives
content-hash dedup and source versioning for free.

## Decision

Per-provider **Monitors** own poll mechanics, watermark shape, and ingest
path: youtube-channel (channel RSS; watermark = video ID + date; first-run
backfill via API/yt-dlp; ingest = `readings/save`), github (SHA/release
timestamp; atom or API), rss/blog (GUID or date+hash; `ingest/web`), reddit
(post ID). RSS is the archetype: one RSS core, provider ingest
specializations. Dedup layers: watermarks (never re-poll) → mdrag
hash/`source_url` (identical content inside one Collection is an update,
never a Duplicate) → semantic match at the Concept_Proposal level (same idea
= new AnnotationSupport edge, not a new proposal). **Recurrence = support
count across distinct Feeds** — a query over edges, not a counter; parked
proposals that keep recurring get re-surfaced ("this keeps coming up").

## Consequences

- The state table stores watermarks per Feed row; `feeds.yaml` stays
  declarative.
- Semantic similarity threshold starts conservative; triage overrides
  calibrate it.
- Re-ingestion is always safe (mdrag update semantics), so adapters may be
  liberal about re-submitting.
