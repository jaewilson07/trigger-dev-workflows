# ADR 0002: Auto-file proposals with `proposed-by-ai` quarantine label

Status: accepted (2026-10-12)

## Context

Options for the human gate: full auto-file, digest-then-approve, or
confidence-tiered auto-file. IdrisBot recommended digest-then-approve on an
uncalibrated extractor. Jae chose auto-file, citing the established live
pattern of issues labeled `proposed`, amended to `proposed-by-ai`. The label
*is* the gate; review happens at triage, not before filing.

## Decision

Auto-file every proposal with `proposed-by-ai`. Weekly Slack triage summary:
filed count, awaiting-triage count, oldest awaiting age; >10 awaiting triggers
an @mention escalation. Triage is two moves: strip the label (accept) or close
(reject). Accept/reject decisions are recorded per Feed as calibration data.

## Consequences

- `proposed-by-ai` must be created in every target repo at setup; existing
  `proposed` labels migrate.
- Auto-promotion stays out of scope until triage data justifies it; the
  graduation path is evidence-gated, not scheduled.
- The review artifact IS the issue — no digest-to-tracker transcription step.
