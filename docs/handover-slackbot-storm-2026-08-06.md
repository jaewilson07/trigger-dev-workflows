# Handover: Slack Bot + STORM Composable Outputs

**Date:** 2026-08-06
**Author:** IdrisBot (build partner session with Jae Wilson)
**Session range:** 2026-08-04 to 2026-08-06

---

## What We Built

### 1. Slack Bot Slash Commands (datacrew repo, PR #427 — MERGED)

Two new commands added to the existing DataCrew Slack bot (`datacrew/slackbot/`):

**`/connect-to-google`** (`commands/connect_to_google.py`)
- Generates a Google Workspace OAuth URL with `scope=workspace` (Drive, Docs, Calendar, Gmail, Tasks)
- Replies ephemerally with the connect link
- Uses the auth service at `AUTH_SERVICE_PUBLIC_URL` (default: `https://api.datacrew.space`)

**`/research`** (`commands/research.py`)
- Triggers the STORM deep-research workflow via trigger.dev REST API
- Checks Google auth before triggering — includes `google_doc` in outputs only if user has a token
- Users without Google auth still get Slack + mdrag outputs
- Passes `outputs`, `slackUserId`, and `slackChannel` in the trigger.dev payload
- Graceful degradation: if Google token lookup fails, drops `google_doc` with a warning instead of erroring

Both commands registered in `server.py` alongside existing commands.

### 2. Composable STORM Workflow (trigger-dev-workflows repo, PR #14 — MERGED)

Refactored the monolithic `generate-briefing` step into a `prepare-report` task plus four independent output tasks:

**Architecture:**
```
storm-research-full-run (orchestrator)
├── steps 1-5: discover, interview, map, synthesize, verify (unchanged)
├── step 6: prepare-report (builds HTML + markdown + summary, delivers nothing)
└── step 7: fan-out to output tasks (independent, pluggable)
    ├── output-slack-briefing  → summary text to Slack DM
    ├── output-slack-md        → full markdown as .md file to Slack DM
    ├── output-google-doc      → creates + shares Google Doc via Drive/Docs API
    └── output-mdrag-ingest    → ingests markdown into mdrag/wiki KB
```

**Key properties:**
- Each output task is independent — adding a new destination is one new task file + one line in the orchestrator
- Every output task catches its own errors and returns `OutputResult` — a failed destination doesn't kill the run
- Default outputs: `["slack_briefing", "slack_md", "mdrag"]` — `google_doc` is opt-in (requires Google auth)
- The `outputs` field in the payload lets callers pick destinations per-run

**Files created/modified:**
- `lib/storm-types.ts` — added `OutputDestination`, `OutputResult`, `StormBriefingWithMarkdown` types
- `tasks/generate-briefing.ts` — renamed task to `prepare-report`, removed Slack posting, added `buildMarkdownReport()`
- `tasks/output-slack-briefing.ts` — NEW: posts summary to Slack DM
- `tasks/output-slack-md.ts` — NEW: posts .md file to Slack DM (uses 3-call external upload protocol)
- `tasks/output-google-doc.ts` — NEW: fetches Google token from auth service, creates doc, writes content, shares with user
- `tasks/output-mdrag-ingest.ts` — NEW: POSTs markdown to mdrag's `/api/v1/ingest/text` endpoint
- `storm-research-full-run.ts` — updated payload types, added fan-out logic, added output results to return
- `trigger.config.ts` — added `GOOGLE_TOKEN_API_KEY` and `DATACREW_API_TOKEN` to `SYNCED_SECRETS`
- `AGENTS.md` — updated architecture diagram and documentation

### 3. STORM Research Run (triggered 2026-08-04)

Triggered a STORM research run on "Opportunities for Domo in light of their recent acquisition."
- Run ID: `run_cmsflkbbg001w4ilaylkutsvq`
- Posted to `#C0BK5MLJR7E` (idris-macchinations channel)

---

## What's NOT Done (Pending)

### A. Webhook + Alert System (Issue #15 — OPEN)

**Goal:** Failed trigger.dev runs post to `#C0BN0KRA6LT` with @DataCrew + Jae mention. Successful runs post to the originating channel.

**Agreed architecture (from grill session):**

1. **`message-slack` trigger.dev task** (TypeScript) — reusable primitive: takes `{ message, channel }`, posts to Slack. Used by:
   - `output-slack-briefing` and `output-slack-md` (refactored to use it)
   - Orchestrator error handling (task-level failures → alert channel)
   - Success notification ("Research complete" → originating channel)

2. **Webhook receiver on mdrag** (Python/FastAPI) — receives trigger.dev's `runFailed` webhook for runner-level crashes. Posts to `#C0BN0KRA6LT` with @DataCrew + Jae mention.

3. **Update `/research` command** — pass `originatingChannelId` in the trigger.dev payload

4. **Update STORM orchestrator** — wrap pipeline in try/catch, call `message-slack` on error, add success notification to fan-out

**Notification rules (confirmed by Jae):**
- Success: AT-mention the triggering user → post to originating channel
- Failure (webhook): AT-mention DataCrew user group AND Jae (`<@U08L4B485B4>`) → post to `#C0BN0KRA6LT`
- Failure (in-workflow): same as webhook

**Blocker:** @DataCrew user group needs a Slack subteam ID. Bot token doesn't have `usergroups:read` scope. Options: (1) Jae provides the subteam ID, (2) add `usergroups:read` scope, (3) fall back to plain text `@DataCrew`.

### B. Slack Bot Not Running

The DataCrew Slack bot is not currently running. To start it:

1. **Install cboti** (local dependency, not in pyproject.toml):
   ```bash
   cd /home/jaewilson07/GitHub/datacrew
   uv add /home/jaewilson07/GitHub/libraries/cboti
   ```

2. **Set env vars** — Jae confirmed signing secret was added to Infisical `/datacrew`. Required:
   - `SLACK_BOT_TOKEN` (from `DATACREW_SLACK_BOT_TOKEN` env var or Infisical)
   - `SLACK_APP_TOKEN` (from `DATACREW_SLACK_APP_TOKEN` env var or Infisical)
   - `SLACK_SIGNING_SECRET` (Jae added to Infisical)

3. **Start the bot:**
   ```bash
   cd /home/jaewilson07/GitHub/datacrew
   uv run slack-bot
   # or: uv run python3 -m datacrew.slackbot.run_bot
   ```

4. **Slack app config:** The slash commands (`/connect-to-google`, `//research`) need to be registered in the Slack app configuration (Slack API dashboard → your app → Slash Commands). The existing commands (`/question`, `/email-summary`, etc.) are already registered.

### C. Trigger.dev Deployment

The STORM workflow code is merged but NOT deployed to the self-hosted trigger.dev instance. To deploy:

```bash
cd /home/jaewilson07/GitHub/trigger-dev-workflows
npm run deploy:storm-research
```

**Pre-deploy checklist:**
- `GOOGLE_TOKEN_API_KEY` must exist in Infisical (synced via `SYNCED_SECRETS`)
- `DATACREW_API_TOKEN` must exist in Infisical (synced via `SYNCED_SECRETS`)
- `LETTA_API_KEY` must exist in Infisical
- `DATACREW_SLACK_BOT_TOKEN` must exist in Infisical
- If any synced secret is missing, the deploy will fail (the sync extension throws)

### D. Known Issues

1. **infra-bonker#396** — Auth service keys Google tokens by `owner_email`, not Slack user ID. Raw Slack user IDs may 400 when looking up Google tokens. The `/research` command handles this gracefully (drops `google_doc` from outputs).

2. **Google Doc plain text** — The `output-google-doc` task inserts markdown as plain text (#, *, etc. visible). A proper Markdown→Docs formatter is a TODO in the task file.

3. **Slack `user:U...` channel format** — The old `generate-briefing` passed `user:U...` directly to `chat.postMessage` which Slack rejects. The new output tasks fix this by stripping the prefix and using `conversations.open`.

4. **WAF User-Agent gotcha** — When triggering tasks via the trigger.dev API, set an explicit `User-Agent` header or Cloudflare's WAF returns 403 (error code 1010). See `AGENTS.md` in the repo root for details.

5. **Bearer token allowlist** — Only the `executive-assistant` prod key bypasses the Turnstile bot-gate. `storm-research` and `watchdog` prod keys get 403. Fix needed in `homeserver/services/auth/gate_router.py`. See `docs/storm-research-rework.md`.

---

## Repos & Key Files

### trigger-dev-workflows (`jaewilson07/trigger-dev-workflows`)
- `storm-research/storm-research-full-run.ts` — main orchestrator
- `storm-research/tasks/` — all task files (prepare-report + 4 output tasks + 5 research tasks)
- `storm-research/lib/storm-types.ts` — shared types
- `storm-research/AGENTS.md` — architecture documentation
- `storm-research/trigger.config.ts` — trigger.dev config with synced secrets
- `AGENTS.md` (root) — repo-wide composition conventions and auth docs

### datacrew (`jaewilson07/datacrew`)
- `slackbot/commands/connect_to_google.py` — `/connect-to-google` command
- `slackbot/commands/research.py` — `/research` command
- `slackbot/commands/email_summary.py` — reference pattern for trigger.dev integration
- `slackbot/server.py` — command registration
- `slackbot/main.py` — entry point
- `slackbot/run_bot.py` — background runner

### Libraries
- `libraries/cboti/` — Slack bot framework, Google Workspace integration, voice handling
- `libraries/cboti/src/cboti/integrations/google/` — GoogleDriveService, GoogleDoc, GoogleWorkspace

---

## Open GitHub Issues

| Repo | Issue | Title | Status |
|------|-------|-------|--------|
| trigger-dev-workflows | #15 | Webhook handler for trigger.dev run status notifications to Slack | OPEN |
| trigger-dev-workflows | #13 | API authentication for self-hosted trigger.dev | OPEN (enhancement) |
| trigger-dev-workflows | #16 | GitHub PR checker for morning brief | OPEN |
| trigger-dev-workflows | #17 | Extract shared Infisical helper | OPEN (ready-for-agent) |
| trigger-dev-workflows | #18 | Add crew-rag-domo daily scrape to watchdog | OPEN (ready-for-agent) |
| datacrew | #420 | Deploy morning brief pipeline on trigger.dev | OPEN (priority: high) |
| datacrew | #425 | Build reusable Domo dashboard template | OPEN |
| datacrew | #424 | Make OKR Pacing Monitor demo-ready | OPEN |
| datacrew | #422 | Build 5-minute demo script | OPEN |
| datacrew | #421 | Write 3-slide wedge deck | OPEN |

---

## Merged PRs

| Repo | PR | Title | Date |
|------|-----|-------|------|
| trigger-dev-workflows | #14 | feat(storm): composable output destinations for STORM research workflow | 2026-08-05 |
| datacrew | #427 | feat(slackbot): add /connect-to-google and /research slash commands | 2026-08-05 |

---

## Next Steps (Priority Order)

1. **Start the slackbot** — install cboti, load env vars, run `uv run slack-bot`
2. **Deploy the STORM workflow** — `npm run deploy:storm-research` (after verifying Infisical secrets)
3. **Register slash commands in Slack** — `/connect-to-google` and `/research` need to be added in the Slack app dashboard
4. **Build the webhook + alert system** (issue #15) — `message-slack` primitive + webhook receiver on mdrag
5. **Fix the bearer token allowlist** — `storm-research` prod key needs to bypass Turnstile (homeserver fix)
6. **Test end-to-end** — `/research <topic>` → STORM runs → Slack briefing + .md file + Google Doc + mdrag ingestion
