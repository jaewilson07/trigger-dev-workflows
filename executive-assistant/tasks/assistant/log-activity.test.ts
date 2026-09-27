import assert from "node:assert/strict";
import { test } from "node:test";
import { buildActivityEntry } from "./log-activity.js";

/**
 * Regression coverage for the log-activity outage diagnosed 2026-09-26:
 * "EACCES: permission denied, mkdir '../data'" — every morning-brief run
 * threw here because the task tried to `mkdir`/`appendFile` a path relative
 * to the ephemeral container's cwd, which is not writable and does not
 * persist across runs regardless. The fix drops the local-file write
 * entirely; `buildActivityEntry` is what's left — a pure function so the
 * entry shape stays covered without needing a filesystem or a Trigger.dev
 * runtime.
 */
test("buildActivityEntry carries the payload through and stamps logged_at", () => {
  const payload = {
    date: "2026-09-26",
    emailCount: 4,
    topicCount: 2,
    slackTs: "1758000000.000100",
    pipelineDurationMs: 12345,
  };

  const entry = buildActivityEntry(payload);

  assert.equal(entry.date, payload.date);
  assert.equal(entry.emailCount, payload.emailCount);
  assert.equal(entry.topicCount, payload.topicCount);
  assert.equal(entry.slackTs, payload.slackTs);
  assert.equal(entry.pipelineDurationMs, payload.pipelineDurationMs);
  assert.equal(typeof entry.logged_at, "string");
  assert.doesNotThrow(() => new Date(entry.logged_at).toISOString());
});

test("buildActivityEntry accepts a null slackTs (delivery skipped/failed)", () => {
  const entry = buildActivityEntry({
    date: "2026-09-26",
    emailCount: 0,
    topicCount: 0,
    slackTs: null,
    pipelineDurationMs: 0,
  });

  assert.equal(entry.slackTs, null);
});
