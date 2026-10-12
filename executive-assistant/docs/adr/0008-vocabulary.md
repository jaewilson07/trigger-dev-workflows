# ADR 0008: Locked vocabulary, aligned to the mdrag glossary

Status: accepted (2026-10-12)

## Context

The system's terms must not contradict mdrag's `CONTEXT.md` (ADR 0022
discipline: use the glossary's vocabulary; don't drift to synonyms it
avoids). Checked against the mdrag glossary during the session: **Source**
is mdrag's harvested-Document subtype; **Signal** is retired (ADR 0017);
**Sweep**, **Transcript**, **Duplicate**, **Provider**, **Job** are live
mdrag terms.

## Decision

The chain: **Feed → Monitor → Feed_Item → Source → Item_Concept →
Concept_Proposal → Project → Proposal → Triage → work**. mdrag terms reused
with mdrag meanings (Source, Annotation, AnnotationSupport, Transcript,
Provider, Job, Sweep). "Source"-for-a-watched-feed and "Signal" deliberately
avoided; the watched thing is a **Feed**, the pre-ingest thing a
**Feed_Item** (RSS naming, since YouTube/GitHub expose RSS/atom). Dedup
lives at the Concept_Proposal level; recurrence is the AnnotationSupport
edge count. snake_case for keys, prose form in docs. Full definitions in
`executive-assistant/CONTEXT.md`.

## Consequences

- CONTEXT.md is law; renaming a term requires a new ADR.
- Output (issues, docs, Slack copy) uses these terms; drift is a review
  finding.
