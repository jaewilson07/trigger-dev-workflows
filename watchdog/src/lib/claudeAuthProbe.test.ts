import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alertText,
  judge,
  parseProbeOutput,
  ProbeOutputError,
  runClaudeAuthProbe,
  type ClaudeAuthProbe,
} from "./claudeAuthProbe.js";
import type { SshTransport } from "./cubbyRunJob.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-29T14:00:00Z");
const ENV = { CUBBY_RUN_JOB_SSH_KEY: "-----BEGIN FAKE-----\nabc\n-----END FAKE-----", CUBBY_SSH_HOST_KEY: "ssh-ed25519 AAAA" };

function probe(over: Partial<ClaudeAuthProbe> = {}): ClaudeAuthProbe {
  return {
    probe: "claude-auth",
    checkedAt: NOW,
    loggedIn: true,
    authMethod: "claude.ai",
    hasRefreshToken: true,
    accessTokenExpiresAt: NOW - 63 * 3_600_000, // prod today: access token long expired, refreshed lazily
    refreshTokenExpiresAt: Date.parse("2026-11-22T01:28:19Z"),
    credentialsMtime: NOW - 3 * DAY,
    error: null,
    ...over,
  };
}

function runWith(p: ClaudeAuthProbe | string, notified: string[]) {
  const transport: SshTransport = async () => ({
    exitCode: 0,
    output: `run-job noise\n${typeof p === "string" ? p : JSON.stringify(p)}\n`,
  });
  return runClaudeAuthProbe({ transport, env: ENV, notify: async (t) => void notified.push(t), now: () => NOW });
}

test("prod as it is today (logged in, refresh token valid for 24 days) stays silent", async () => {
  const notified: string[] = [];
  const r = await runWith(probe(), notified);
  assert.equal(r.status, "checked");
  assert.equal(r.status === "checked" && r.verdict.status, "ok");
  assert.deepEqual(notified, []);
});

test("loggedIn=false alerts as down", async () => {
  const notified: string[] = [];
  await runWith(probe({ loggedIn: false, hasRefreshToken: false, refreshTokenExpiresAt: null }), notified);
  assert.equal(notified.length, 1);
  assert.match(notified[0]!, /DOWN/);
  assert.match(notified[0]!, /loggedIn=false/);
});

test("credentials made invalid: refresh token past its end date alerts even though the CLI says loggedIn", async () => {
  const notified: string[] = [];
  await runWith(probe({ loggedIn: true, refreshTokenExpiresAt: NOW - 1000 }), notified);
  assert.equal(notified.length, 1);
  assert.match(notified[0]!, /DOWN.*refresh token expired/);
});

test("a login ending within 7 days warns; 8 days stays silent", async () => {
  const soon: string[] = [];
  await runWith(probe({ refreshTokenExpiresAt: NOW + 6 * DAY }), soon);
  assert.equal(soon.length, 1);
  assert.match(soon[0]!, /lapses in about 6 day/);
  const later: string[] = [];
  await runWith(probe({ refreshTokenExpiresAt: NOW + 8 * DAY }), later);
  assert.deepEqual(later, []);
});

test("could not ask the CLI (loggedIn null) alerts rather than staying silent", async () => {
  const notified: string[] = [];
  await runWith(probe({ loggedIn: null, error: "claude auth status failed: ENOENT" }), notified);
  assert.equal(notified.length, 1);
  assert.match(notified[0]!, /could not ask the CLI/);
});

test("no expiry field and a refresh token present is not an alert", () => {
  assert.equal(judge(probe({ refreshTokenExpiresAt: null }), NOW).status, "ok");
});

test("alert text never carries anything but dates and reasons", () => {
  const v = judge(probe({ loggedIn: false }), NOW);
  assert.ok(v.status === "down");
  assert.doesNotMatch(alertText(v, NOW), /sk-ant|accessToken|refreshToken"/);
});

test("cubby offline is skipped, not an alert", async () => {
  const notified: string[] = [];
  const transport: SshTransport = async () => {
    throw Object.assign(new Error("unreachable"), { code: "EHOSTUNREACH" });
  };
  const r = await runClaudeAuthProbe({ transport, env: ENV, notify: async (t) => void notified.push(t), now: () => NOW });
  assert.equal(r.status, "skipped");
  assert.deepEqual(notified, []);
});

test("garbage output fails loudly instead of passing as healthy", async () => {
  await assert.rejects(runWith("not json", []), ProbeOutputError);
  assert.throws(() => parseProbeOutput('{"probe":"claude-auth","loggedIn":"yes"}'), ProbeOutputError);
});
