# ADR 0004: Item_Concepts as mdrag Annotations, with a thin state table

Status: accepted (2026-10-12)

## Context

Extracted concepts need a persistent shape for dedup, issue linkage, and the
parked (no-match) bucket. Options: standalone mdrag documents, GitHub issues
only, or Annotations. Jae refined: the concept should be an Annotation with
support citing the inspiring transcript.

## Decision

An Item_Concept is an mdrag **Annotation** (`document_type: "annotation"`) on
its Source Document, carrying AnnotationSupport (verbatim quotation +
timestamp locator) and the concept analysis as its body. A thin scanner-side
state table holds watermarks, issue links, and status — the bookkeeping mdrag
shouldn't carry. Provenance chain: Source → Item_Concept (Annotation) →
Proposal (issue).

## Consequences

- Full-text and semantic search over concepts come free; semantic search is
  the fuzzy-dedup mechanism (ADR 0005).
- Mutable state never lives in mdrag documents (updates are re-ingests).
- `lib/learn-annotations.ts` is the existing client to build on.
