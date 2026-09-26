import assert from "node:assert/strict";
import { test } from "node:test";
import { requireSyncedEnv } from "./require-env.js";

/**
 * Regression test for the daily-standup outage diagnosed 2026-09-26:
 * "Missing INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET — required to look
 * up secrets from Infisical." — thrown by `getSecret("JAEWILSON07_GH_PAT")`
 * because this project's Trigger.dev dashboard never had
 * INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET set (a project-scoped runtime
 * prerequisite `watchdog`/`indb-blues` happen to have, but
 * `executive-assistant` never did).
 *
 * The fix switches `daily-standup.ts` to `process.env` (populated at build
 * time by `trigger.config.ts`'s SYNCED_SECRETS, the pattern every other
 * executive-assistant task already uses) instead of a runtime Infisical
 * lookup. This exercises the new seam directly: it must still fail LOUDLY
 * when the name is absent (no silent empty-string fallback that would let a
 * broken clone/PAT surface far from its real cause), and return the value
 * when present.
 */
test("requireSyncedEnv throws a clear error when the env var is absent", () => {
  const original = process.env.JAEWILSON07_GH_PAT;
  delete process.env.JAEWILSON07_GH_PAT;
  try {
    assert.throws(() => requireSyncedEnv("JAEWILSON07_GH_PAT"), /Missing JAEWILSON07_GH_PAT/);
  } finally {
    if (original === undefined) delete process.env.JAEWILSON07_GH_PAT;
    else process.env.JAEWILSON07_GH_PAT = original;
  }
});

test("requireSyncedEnv returns the value when present", () => {
  const original = process.env.JAEWILSON07_GH_PAT;
  process.env.JAEWILSON07_GH_PAT = "ghp_test-token";
  try {
    assert.equal(requireSyncedEnv("JAEWILSON07_GH_PAT"), "ghp_test-token");
  } finally {
    if (original === undefined) delete process.env.JAEWILSON07_GH_PAT;
    else process.env.JAEWILSON07_GH_PAT = original;
  }
});
