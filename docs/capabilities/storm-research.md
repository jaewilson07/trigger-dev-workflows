---
type: capability
status: current
map: https://github.com/jaewilson07/mdrag/issues/1141
---

# STORM research

Give it a topic; get back a cited, fact-checked report built from several
expert perspectives arguing with each other. The deep-research mode.

Harvested 2026-08-25 from [jaewilson07/mdrag#1026](https://github.com/jaewilson07/mdrag/issues/1026)
(resumable Conversation + per-source ingest) and
[#1017](https://github.com/jaewilson07/mdrag/issues/1017) (identity and
collection routing), both closed. Story numbers are those issues' own, prefixed
by issue.

**Why this doc lives here and not in mdrag.** Capabilities are per repo, and
STORM's tasks are in this one, in `executive-assistant`'s `research` subdomain
(`executive-assistant/storm-research.ts`, `storm-deliver.ts`,
`storm-research-full-run.ts`, and their children under
`executive-assistant/tasks/research/` — see ADR-001's 2026-09-02 addendum).
mdrag's `CAPABILITIES.md` indexes it and points here.

**The pipeline**, from `storm-research.ts:18-24`:

1. `discover-perspectives` → 5+ expert lenses for the topic
2. `conduct-interview` (×N parallel) → each lens researches
3. `map-contradictions` → disagreements and gaps across lenses
4. `synthesize-report` → themed sections with citations
5. `verify-sources` (×6 shards) → adversarial fact-check, looping back to 4

Steps 4↔5 are an evaluator-optimizer loop: verification failures feed back into
synthesis until every claim is confirmed or `maxRevisionRounds` is hit.

---

## The research itself

| # | Story | State | Evidence |
|---|---|---|---|
| S1 | As a researcher, I want several genuinely different expert viewpoints, so that the report isn't one model's single angle. | **met** | `discover-perspectives`, then `conduct-interview` per lens; `executive-assistant/tasks/research/conduct-interview.ts:14-17` assigns a Letta agent per lens. |
| S2 | As a researcher, I want disagreement between sources surfaced rather than smoothed over. | **met** | `map-contradictions` (step 3). |
| S3 | As a researcher, I want claims fact-checked against their sources before I read them. | **met** | `verify-sources` across 6 shards, feeding the revision loop. |
| S4 | As a researcher, I want an hours-long run to survive a crash. | **met** | trigger.dev v4 serialises the call stack after every `await`; `storm-research.ts:45-49` documents checkpoint-resume as what makes the loop practical. |
| S5 | As a researcher, I want to watch progress while it runs. | **met** | `metadata.root` seeding, `storm-research.ts:53-58`. |
| S6 | As an operator, I want a bad delivery to be a re-delivery, not a re-run. | **met** | The research/deliver seam is deliberate — `storm-research.ts:37-41`: "the research was fine, the Slack channel was wrong" is a re-delivery. `storm-deliver.ts` is the other half. |

## Reaching knowledge through mdrag — the substrate invariant

Jae's standing principle (recorded on [mdrag#1141](https://github.com/jaewilson07/mdrag/issues/1141)):
where a mode runs matters less than that **every mode reaches knowledge only
through mdrag's search, storage and retrieval tooling.** STORM honours the
write half and not the read half.

| # | Story | State | Evidence |
|---|---|---|---|
| 1026-1 | Every source the report cites is saved in mdrag, so I can return to the original material. | **met** | `outputMdragIngestSources`, imported at `executive-assistant/storm-deliver.ts:7`; aggregate result at `:105`. |
| 1026-2 | Each saved source carries its own summary. | **met** | Save-time summary Annotation (mdrag ADR-0017), extended past web sources by mdrag#686. |
| 1026-3 | Report and sources land in the same collection. | **met** | `storm-deliver.ts:88` — one collection for the run's whole trail. |
| 1026-4 | The collation step runs inside a real mdrag Conversation registered to me, so the report is the conversation's genuine first reply. | **met** | `resolveOrCreateConversation`, `executive-assistant/lib/mdrag-conversation-resolver.ts`, called at `storm-research.ts:94-101` with `conversationExternalRef = storm-research:${ctx.run.id}`. |
| 1026-5 | I can open that conversation later in the wiki and ask follow-ups. | **met** | Same Conversation id; the wiki's `/conversations/[id]` renders it. |
| 1026-6 | A second unrelated run gets its own conversation. | **met** | The external ref is keyed on `ctx.run.id`. |
| 1026-7 | I can see the revision back-and-forth if I open the conversation. | **partial** | The loop exists and the Conversation exists; whether each revision round is written as a turn is not established here. |
| 1026-13 | Per-source ingestion is skippable via the existing "mdrag" output toggle, not a new switch. | **met** | `storm-deliver.ts:60,243` — same toggle gates both ingest steps. |
| 1017-1, 1017-3, 1017-4 | Research lands in my personal collection by default, is routable to a project collection, and auto-provisions on first use. | **met** | `storm-deliver.ts:88,235` — mdrag resolves the ingest to the caller's own collection when none is given. |
| **R1** | **As a researcher, I want the research itself to search my knowledge base, not only the open web — so that what I've already saved informs the report.** | **unmet** | `tasks/research/conduct-interview.ts:20` — "The Letta agent uses `web_search` + `fetch_webpage` tools to find answers." Each lens searches the open web through its own agent tools. **This repo already has the mdrag path** — `executive-assistant/lib/mdrag-topic-search.ts` and `mdrag-primitives.ts`, used elsewhere (`lib/brief-rows.test.ts:31` shows results tagged `source: "mdrag/searxng"`). STORM's interview simply does not call it. This is the single unmet invariant for this mode. |
| **R2** | As a researcher, I want STORM not to re-fetch and re-summarise a page mdrag already holds. | **unmet** | Follows from R1. `lib/mdrag-seen-articles.ts` exists for a related de-duplication need elsewhere. |

## Identity

| # | Story | State | Evidence |
|---|---|---|---|
| 1017-5, 1017-6, 1017-7 | The identity fallback must not re-attribute a fixed-service collection, must let a trusted `x-user-email` header win, and must keep the anonymous fallback working. | **met** | mdrag#1017, closed. Note mdrag#1041 later found `/api/v1/readings` taking identity from the raw header unsafely — same header, different route. |
| 1017-12 | Re-running the same topic upserts rather than duplicating. | **met** | mdrag upserts on `source_url` (ADR-0016). |

---

## Contradictions and open questions recorded, not resolved

- **"STORM should become a deep research experience."** Jae's framing on #1141
  puts STORM alongside the wiki's interactive modes, while the host boundary he
  settled says trigger.dev is for *non-interactive* workflows and interactive
  thinking-partner conversations belong on the wiki. STORM is currently
  fire-and-read: you trigger it and a report arrives. Whether "deep research"
  means making it interactive (and therefore moving it) or making it better at
  being non-interactive is undecided. Host-boundary ADR:
  [mdrag#1143](https://github.com/jaewilson07/mdrag/issues/1143).
- **Two agent identities do the work and that is deliberate.** #1026 story 12
  asked for it to be documented that fact-finding runs on a fixed shared
  research agent while report-writing runs in the caller's own per-user
  conversation agent. Recorded here; whether it should stay that way is not
  argued.
- **R1 may be intentional.** An argument exists that a research sweep *should*
  reach the open web unfiltered, and that grounding it in an existing KB would
  narrow it to what the user already believes. Nothing in #1026 or #1141
  addresses this, and the invariant is stated without the exception. Recorded so
  whoever closes R1 has to answer it rather than assume.

## Related

- mdrag's index: `libraries/mdrag/CAPABILITIES.md`.
- Decisions: mdrag ADR-0016 (ingest identity is `source_url`), ADR-0017
  (annotations are authored Documents).
- Deploy: this project is bonker-only — see `.agents/skills/deploy-trigger-tasks`.
