# storm-research

STORM (Synthesis of Topic Outlines through Retrieval and Multi-perspective question asking) — Stanford OVAL lab method, implemented as a trigger.dev workflow backed by Letta Cloud agents.

## Architecture

```
storm-research-full-run (parent orchestrator)
├── discover-perspectives     → 5+ expert lenses + initial questions
├── conduct-interview (×N)    → parallel research via Letta agents (web_search + fetch_webpage)
├── map-contradictions        → surface disagreements + gaps
├── synthesize-report         → themed sections with inline citations
├── verify-sources (×6)       → parallel adversarial fact-checking
│   └── (loop back to synthesize if claims fail, up to maxRevisionRounds)
├── prepare-report            → packages HTML + Markdown + summary (delivers nothing)
└── output-* (fan-out)        → delivers to the requested destinations
    ├── output-slack-briefing → summary text to a channel/DM
    ├── output-slack-md       → full Markdown as a .md file upload
    ├── output-google-doc     → Google Doc shared with the user
    └── output-mdrag-ingest   → Markdown into the mdrag wiki
```

## Composable outputs

Report *building* and report *delivery* are separate. `prepare-report` produces
one `StormBriefingWithMarkdown` (HTML, Markdown, plain-text summary, counts) and
posts nowhere. Each `output-*` task takes that same briefing and returns an
`OutputResult`:

```ts
type OutputDestination = "slack_briefing" | "slack_md" | "google_doc" | "mdrag";
type OutputResult = { destination: OutputDestination; success: boolean; url?: string; error?: string };
```

| Destination | Task | Needs | Env |
|---|---|---|---|
| `slack_briefing` | `output-slack-briefing` | `slackChannel` or `slackUserId` | `DATACREW_SLACK_BOT_TOKEN` |
| `slack_md` | `output-slack-md` | `slackChannel` or `slackUserId` | `DATACREW_SLACK_BOT_TOKEN` |
| `google_doc` | `output-google-doc` | `slackUserId` | `AUTH_SERVICE_URL`, `GOOGLE_TOKEN_API_KEY` |
| `mdrag` | `output-mdrag-ingest` | — | `DATACREW_API_TOKEN` |

Rules the fan-out follows:

- **Default** is `["slack_briefing", "slack_md", "mdrag"]`. Override with `outputs`.
- **Failures are contained.** Every output task catches its own errors and
  returns `success: false` rather than throwing. A destination missing its
  addressing (e.g. `google_doc` with no `slackUserId`) is recorded as skipped.
  The run still completes, and `StormResearchResult.outputs` reports what landed.
- **Adding a destination** = one new `output-*.ts` task returning `OutputResult`,
  one arm in the orchestrator's fan-out loop, one entry in `OutputDestination`.

### Known gaps

- `output-google-doc` is **implemented** (auth-service token fetch → Drive file
  create → Docs `batchUpdate` → Drive permission share, all via `fetch`). Two
  caveats: it inserts the Markdown as **plain text**, so `#`/`*` show up
  literally in the doc — a Markdown→Docs formatter (`updateParagraphStyle` /
  `updateTextStyle` requests) is a TODO in the file. And per infra-bonker#396 the
  auth service keys tokens by canonical `owner_email`, so a raw Slack user ID may
  400 until that lands.
- A doc that is created but fails at the write or share step is still reported as
  `success: true` with its URL — the failure is logged, not surfaced. Rationale:
  the doc exists and the token holder can open it, so returning an error would
  hide a real artifact.
- `output-slack-md` implements Slack's real 3-call external upload protocol
  (`files.getUploadURLExternal` → POST the bytes → `files.completeUploadExternal`)
  because `files.uploadV2` is an SDK helper, not an HTTP endpoint. If any step
  fails it falls back to posting the Markdown in a code block.

## Letta Cloud Integration

STORM uses two existing Letta Cloud agents from the DataCrew multi-agent fleet:

- **EmmaBot** (`agent-5afcfa48-81d3-430f-87fe-0a814fecff7e`) — deep research agent. Used for practitioner, academic, economist, historian, and any custom perspectives. Also used for meta-tasks (contradiction mapping, synthesis, verification).
- **IdrisBot** (`agent-0604eb6c-85b1-46f9-9c13-fb147d85bf2a`) — the skeptic. His naturally critical persona makes him a better skeptic than a prompt-injected lens on a generic agent.

### Agent assignment

| Lens | Agent | Why |
|------|-------|-----|
| practitioner | EmmaBot | Deep research, community knowledge |
| academic | EmmaBot | Deep research |
| skeptic | IdrisBot | Naturally critical persona |
| economist | EmmaBot | Deep research |
| historian | EmmaBot | Deep research |
| custom lenses | EmmaBot | Default (unless lens is "skeptic") |
| map-contradictions | EmmaBot | Meta-task, not perspective-specific |
| synthesize-report | EmmaBot | Meta-task |
| verify-sources | EmmaBot | Meta-task |

### API

- `POST /v1/agents/{id}/messages` with `override_model: letta/auto-fast`
- Perspective prompts injected via user message (agent's own persona stays intact)
- 409 retry built in (shared agents can be busy with other surfaces like Slack)
- Model: `letta/auto-fast` (plan-covered)

### Concurrency

- 4 EmmaBot perspectives will 409 each other (one stateful conversation). The 409 retry with backoff handles this — perspectives wait their turn.
- IdrisBot (skeptic) runs independently since it's a different agent — at least 2 perspectives can truly run in parallel.
- Shared history tradeoff: all EmmaBot perspectives share one conversation, so later perspectives can see earlier ones' research. Sometimes a feature (cross-perspective awareness), sometimes a bias risk. Switch to Conversations API if isolation becomes important.

## Setup

1. No new agents needed — EmmaBot and IdrisBot already exist on Letta Cloud with `web_search` + `fetch_webpage` tools
2. Create a trigger.dev project: `trigger.dev init --project storm-research`
3. Set `TRIGGER_PROJECT_REF` in `.env` (copy from `.env.example`)
4. Set `LETTA_API_KEY` (synced from Infisical `/letta` at deploy time)
5. Set `DATACREW_SLACK_BOT_TOKEN` (synced from Infisical `/datacrew` at deploy time)
6. `DATACREW_API_TOKEN` (mdrag) and `GOOGLE_TOKEN_API_KEY` (google_doc) are in `SYNCED_SECRETS` in `trigger.config.ts` — both must exist in Infisical or the sync extension throws on deploy
7. For the `google_doc` output: set `AUTH_SERVICE_URL` if the auth service isn't at the `http://auth-service:8000` default

## Development

```bash
npm run dev:storm-research          # local dev server
npm run deploy:storm-research       # deploy to self-hosted instance
npm run typecheck:storm-research    # typecheck only
```

## Triggering

From the trigger.dev dashboard Test tab:
```json
{"topic": "The impact of AI agents on enterprise data engineering"}
```

With options:
```json
{
  "topic": "Domo's acquisition strategy and customer impact",
  "customPerspectives": ["security", "legal", "customer-success"],
  "maxRevisionRounds": 3,
  "slackUserId": "U08L4B485B4",
  "slackChannel": "user:U08L4B485B4",
  "outputs": ["slack_briefing", "slack_md", "google_doc", "mdrag"]
}
```

`slackChannel` defaults to a DM to `slackUserId`. With neither set, the Slack
destinations are skipped (recorded in `outputs`) and the run still finishes —
useful for dashboard test runs that only want `mdrag`.

Or from Slack: `/research <topic>` — the bot checks whether you've connected
Google and adds `google_doc` to the outputs if so
(`datacrew/slackbot/commands/research.py`).

## Key Design Decisions

- **Existing agents, not new ones**: Uses EmmaBot (deep research) and IdrisBot (skeptic) from the DataCrew fleet. IdrisBot's naturally critical persona makes him a better skeptic than a prompt-injected lens.
- **Evaluator-optimizer loop**: Verify → revise → re-verify until all claims pass or max rounds hit. This is the "agentic" part — the workflow improves its own output.
- **Parallel sharding for verification**: 6 verification agents check different subsets of claims simultaneously.
- **Checkpoint-resume**: trigger.dev v4 serializes after every `await`, so a crash mid-workflow resumes from the last checkpoint.
- **Build ≠ deliver**: `prepare-report` produces the artifact; `output-*` tasks deliver it. Destinations are data (`outputs: [...]`), so callers pick them per-run and a new destination is additive rather than a change to the report builder.
- **Outputs never fail the run**: hours of research shouldn't be lost to a Slack 500. Every output task returns `OutputResult` instead of throwing, and the orchestrator reports the full set.
