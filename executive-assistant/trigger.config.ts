import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@datacrew/trigger-shared";

/**
 * Secrets this project pulls from Infisical at deploy time.
 *
 * An ALLOWLIST, not a passthrough. A recursive list from `/` returns ~277
 * secrets spanning every app in the org (/letta, /mdrag, /paperclip, /alix,
 * /claude-slack, ...), and syncing all of them would copy the whole org's
 * credentials into this one trigger.dev environment, where they would show up
 * on the Environment Variables page and outlive whatever needed them. Add a
 * name here when a task genuinely needs it.
 *
 * The names are folder-scoped and NOT interchangeable: LETTA_API_KEY (/letta)
 * is the Letta Cloud key, while /datacrew holds a different
 * DATACREW_LETTA_API_KEY and /mdrag a different PRIMITIVES_LETTA_API_KEY.
 *
 * DATACREW_SLACK_BOT_TOKEN, GOOGLE_TOKEN_API_KEY, DATACREW_API_TOKEN added
 * when storm-research folded into this project (2026-08-12) — its own
 * `syncEnvVars` call synced the same three, unchanged here.
 *
 * MDRAG_TOKEN added 2026-08-12 (#51): `lib/mdrag-conversation-resolver.ts`
 * (used by both Pattern Hunter and STORM's new conversation-resolution step)
 * reads this separately from DATACREW_API_TOKEN, sending it as `X-DC-Token`
 * rather than `Authorization: Bearer`. It had never been added to this
 * allowlist, so it was set directly in the Trigger.dev dashboard instead —
 * which meant it silently held a pre-`jti` dead token (jaewilson07/mdrag#1029)
 * with no path to fix it short of manual dashboard edits, unlike every other
 * credential here. Same value as DATACREW_API_TOKEN; kept as its own
 * Infisical name (not consolidated onto one credential/header) to avoid
 * touching Pattern Hunter's existing, working call shape in the same change
 * that fixes STORM's.
 *
 * ANTHROPIC_API_KEY deliberately NOT here, despite `lib/conversation-agent.ts`
 * reading it: that file already treats it as one of several optional fallback
 * credentials (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for Claude, else
 * LETTA_API_KEY + MORNING_BRIEF_USER_EMAIL for Letta) and handles its absence
 * gracefully. `syncEnvVars` (packages/shared/src/infisical.ts) throws if ANY
 * allowlisted name is missing from Infisical, and — because the throw happens
 * before anything is returned — that failure silently drops EVERY secret in
 * this list, not just the missing one. ANTHROPIC_API_KEY has never existed in
 * Infisical (verified 2026-08-12), so it was in this array, at deploy time,
 * every deploy of this project failed to sync ANYTHING, including
 * LETTA_API_KEY — discovered while folding storm-research in. If a real
 * Anthropic key is ever added to Infisical and this project should actually
 * require it, add it back.
 */
const SYNCED_SECRETS = [
  "LETTA_API_KEY",
  "DATACREW_SLACK_BOT_TOKEN",
  "GOOGLE_TOKEN_API_KEY",
  "DATACREW_API_TOKEN",
  "MDRAG_TOKEN",
];

/**
 * executive-assistant — trigger.dev v4 project config.
 *
 * Renamed from "Morning Briefing" (proj_noaaludkbpoorzosejyn on the
 * self-hosted instance at triggers.datacrew.space); the ref itself doesn't
 * change on rename. Set TRIGGER_PROJECT_REF in `.env` (see .env.example) —
 * read from env so nothing is committed.
 *
 * Verify with:
 *   docker exec trigger-postgres-1 psql -U postgres -d main \
 *     -tAc 'select "externalRef", name from "Project";'
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  // dirs is resolved relative to this config file. Tasks live alongside it
  // (./morning-brief.ts, ./email-digest.ts, ./tasks/*.ts, ./demo/*.ts), so
  // index the whole dir. lib/*.ts files are plain modules (no task()/
  // schedules.task() export), so the build silently skips them.
  //
  // CAUTION: this indexes compiled output too, and the indexer does NOT
  // respect .gitignore. A `dist/` here from a local `tsc --outDir` gets
  // imported at build time -- and a module with top-level await executes,
  // failing the deploy with whatever that code touched. `npm test` therefore
  // builds into $TMPDIR, not into the project. Keep it that way.
  dirs: ["."],
  maxDuration: 3600,
  build: {
    extensions: [syncEnvVars(SYNCED_SECRETS)],
  },
});
