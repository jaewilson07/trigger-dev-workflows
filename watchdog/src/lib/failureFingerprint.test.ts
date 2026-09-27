import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFailureFingerprint,
  buildFingerprintMarker,
  buildTaskMarker,
  extractFingerprintMarker,
  extractTaskMarker,
  normalizeErrorMessage,
} from "./failureFingerprint.js";

test("normalizeErrorMessage: strips numbers", () => {
  assert.equal(normalizeErrorMessage("failed after 3 retries in 42ms"), "failed after <n> retries in <n>ms");
});

test("normalizeErrorMessage: strips uuids", () => {
  const out = normalizeErrorMessage("run 550e8400-e29b-41d4-a716-446655440000 crashed");
  assert.ok(!out.includes("550e8400"));
  assert.match(out, /<id>/);
});

test("normalizeErrorMessage: strips timestamps", () => {
  const out = normalizeErrorMessage("failed at 2026-09-26T14:03:11.123Z during clone");
  assert.ok(!out.includes("2026-09-26"));
  assert.match(out, /<ts>/);
});

test("normalizeErrorMessage: strips id-bearing paths", () => {
  const out = normalizeErrorMessage("write failed: /tmp/run-8f3a2c1/output.json is not writable");
  assert.ok(!out.includes("/tmp/run-8f3a2c1"));
});

test("normalizeErrorMessage: strips long hex/shas", () => {
  const out = normalizeErrorMessage("checkout of a1b2c3d4e5f60718293a4b5c6d7e8f901234567 failed");
  assert.ok(!out.includes("a1b2c3d4e5f60718293a4b5c6d7e8f901234567"));
});

test("normalizeErrorMessage: collapses whitespace and lowercases", () => {
  assert.equal(normalizeErrorMessage("Uv   Run\nFailed"), "uv run failed");
});

test("buildFailureFingerprint: identical shape, different run-specific details -> same fingerprint", () => {
  const a = buildFailureFingerprint(
    "crew-rag-domo-scrape",
    "HTTPError",
    "clone failed after 3 retries at 2026-09-11T09:00:00Z, run 550e8400-e29b-41d4-a716-446655440000"
  );
  const b = buildFailureFingerprint(
    "crew-rag-domo-scrape",
    "HTTPError",
    "clone failed after 7 retries at 2026-09-25T03:15:42Z, run 123e4567-e89b-12d3-a456-426614174000"
  );
  assert.equal(a, b);
});

test("buildFailureFingerprint: different task id -> different fingerprint", () => {
  const a = buildFailureFingerprint("crew-rag-domo-scrape", "HTTPError", "clone failed");
  const b = buildFailureFingerprint("daily-standup", "HTTPError", "clone failed");
  assert.notEqual(a, b);
});

test("buildFailureFingerprint: different error message shape -> different fingerprint", () => {
  const a = buildFailureFingerprint("daily-standup", "Error", "missing INFISICAL_CLIENT_ID");
  const b = buildFailureFingerprint("daily-standup", "Error", "no gh binary on PATH");
  assert.notEqual(a, b);
});

test("buildFailureFingerprint: fixed length, hex-only output safe for a hidden marker", () => {
  const fp = buildFailureFingerprint("t", "E", "m");
  assert.equal(fp.length, 16);
  assert.match(fp, /^[0-9a-f]{16}$/);
});

test("marker round-trip: build then extract returns the same fingerprint", () => {
  const fp = buildFailureFingerprint("job-search", "TypeError", "localhost refused connection");
  const body = `**Task:** job-search\n\nsome body text\n\n${buildFingerprintMarker(fp)}`;
  assert.equal(extractFingerprintMarker(body), fp);
});

test("extractFingerprintMarker: returns null when no marker present", () => {
  assert.equal(extractFingerprintMarker("just a regular issue body, no marker here"), null);
});

test("task marker round-trip: build then extract returns the same task id", () => {
  const body = `some body text\n\n${buildTaskMarker("crew-rag-domo-scrape")}`;
  assert.equal(extractTaskMarker(body), "crew-rag-domo-scrape");
});

test("extractTaskMarker: returns null when no task marker present", () => {
  assert.equal(extractTaskMarker("just a regular issue body, no marker here"), null);
});

test("extractTaskMarker: does not confuse a fingerprint marker for a task marker", () => {
  const fp = buildFailureFingerprint("t", "E", "m");
  assert.equal(extractTaskMarker(buildFingerprintMarker(fp)), null);
});
