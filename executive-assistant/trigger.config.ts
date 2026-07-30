import { defineConfig } from "@trigger.dev/sdk";

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
  dirs: ["."],
  maxDuration: 3600,
});
