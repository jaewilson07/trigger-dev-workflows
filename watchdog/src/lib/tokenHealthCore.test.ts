import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReport,
  classifyPrefix,
  findDuplicateWarnings,
  formatAlertMessage,
  groupByValue,
  hashValue,
  parseReferenceTarget,
  trackSecrets,
  updateDeadSinceState,
  valuePrefix4,
  type SecretRecord,
} from "./tokenHealthCore.js";

// ---------------------------------------------------------------------------
// classifyPrefix / valuePrefix4 / parseReferenceTarget
// ---------------------------------------------------------------------------

test("classifyPrefix: recognizes dc_ and mat_, ignores everything else", () => {
  assert.equal(classifyPrefix("dc_abc123"), "dc");
  assert.equal(classifyPrefix("mat_abc123"), "mat");
  assert.equal(classifyPrefix("sk-abc123"), null);
  assert.equal(classifyPrefix(""), null);
});

test("valuePrefix4: first 4 characters only", () => {
  assert.equal(valuePrefix4("mat_abcdefgh"), "mat_");
  assert.equal(valuePrefix4("dc_abcdefgh"), "dc_a");
});

test("parseReferenceTarget: extracts an Infisical reference target", () => {
  assert.equal(parseReferenceTarget("${prod.datacrew.DATACREW_API_TOKEN}"), "prod.datacrew.DATACREW_API_TOKEN");
  assert.equal(parseReferenceTarget("mat_abc123"), null);
  assert.equal(parseReferenceTarget("  ${prod.x.Y}  "), "prod.x.Y");
});

test("hashValue: deterministic, short, never the raw value", () => {
  const h1 = hashValue("mat_supersecret");
  const h2 = hashValue("mat_supersecret");
  assert.equal(h1, h2);
  assert.equal(h1.length, 16);
  assert.ok(!h1.includes("supersecret"));
});

// ---------------------------------------------------------------------------
// trackSecrets / groupByValue
// ---------------------------------------------------------------------------

function rec(overrides: Partial<SecretRecord>): SecretRecord {
  return {
    name: "SOME_TOKEN",
    path: "/datacrew",
    environment: "prod",
    value: "mat_abc",
    rawValue: "mat_abc",
    ...overrides,
  };
}

test("trackSecrets: filters to dc_/mat_ values only, and classifies each", () => {
  const tracked = trackSecrets([
    rec({ name: "A", value: "dc_1", rawValue: "dc_1" }),
    rec({ name: "B", value: "mat_1", rawValue: "mat_1" }),
    rec({ name: "C", value: "not-a-token", rawValue: "not-a-token" }),
  ]);
  assert.equal(tracked.length, 2);
  assert.equal(tracked.find((t) => t.name === "A")?.prefix, "dc");
  assert.equal(tracked.find((t) => t.name === "B")?.prefix, "mat");
});

test("trackSecrets: flags a reference by its raw (unexpanded) value", () => {
  const tracked = trackSecrets([
    rec({ name: "DATACREW_API_TOKEN", environment: "dev", value: "dc_shared", rawValue: "${prod.datacrew.DATACREW_API_TOKEN}" }),
  ]);
  assert.equal(tracked[0].referenceTarget, "prod.datacrew.DATACREW_API_TOKEN");
});

test("groupByValue: one group per distinct expanded value, regardless of name count", () => {
  const tracked = trackSecrets([
    rec({ name: "DATACREW_API_TOKEN", environment: "prod", value: "dc_shared", rawValue: "dc_shared" }),
    rec({ name: "DATACREW_API_TOKEN", environment: "dev", value: "dc_shared", rawValue: "${prod.datacrew.DATACREW_API_TOKEN}" }),
    rec({ name: "OTHER", environment: "prod", value: "mat_other", rawValue: "mat_other" }),
  ]);
  const groups = groupByValue(tracked);
  assert.equal(groups.length, 2);
  const sharedGroup = groups.find((g) => g.value === "dc_shared");
  assert.equal(sharedGroup?.entries.length, 2);
});

// ---------------------------------------------------------------------------
// findDuplicateWarnings
// ---------------------------------------------------------------------------

test("findDuplicateWarnings: a value with two DIRECT names is a duplicate warning", () => {
  const tracked = trackSecrets([
    rec({ name: "MDRAG_ADMIN_SERVICE_TOKEN", path: "/website", environment: "prod", value: "mat_dup", rawValue: "mat_dup" }),
    rec({ name: "MDRAG_ACCESS_TOKEN_PERSONAL", path: "/mdrag", environment: "prod", value: "mat_dup", rawValue: "mat_dup" }),
  ]);
  const warnings = findDuplicateWarnings(groupByValue(tracked));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].names.length, 2);
});

test("findDuplicateWarnings: a reference pointing at its source is NOT a duplicate", () => {
  const tracked = trackSecrets([
    rec({ name: "DATACREW_API_TOKEN", environment: "prod", value: "dc_shared", rawValue: "dc_shared" }),
    rec({ name: "DATACREW_API_TOKEN", environment: "dev", value: "dc_shared", rawValue: "${prod.datacrew.DATACREW_API_TOKEN}" }),
  ]);
  const warnings = findDuplicateWarnings(groupByValue(tracked));
  assert.equal(warnings.length, 0);
});

test("findDuplicateWarnings: two references to the same source, no direct holder, is not flagged", () => {
  const tracked = trackSecrets([
    rec({ name: "A", environment: "dev", value: "dc_shared", rawValue: "${prod.datacrew.DATACREW_API_TOKEN}" }),
    rec({ name: "B", environment: "staging", value: "dc_shared", rawValue: "${prod.datacrew.DATACREW_API_TOKEN}" }),
  ]);
  const warnings = findDuplicateWarnings(groupByValue(tracked));
  assert.equal(warnings.length, 0);
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

test("buildReport: a dead value reports every name that holds it, with first-seen deadSince", () => {
  const tracked = trackSecrets([
    rec({ name: "A", environment: "prod", value: "mat_dead", rawValue: "mat_dead" }),
    rec({ name: "B", environment: "dev", value: "mat_dead", rawValue: "${prod.mdrag.A}" }),
  ]);
  const groups = groupByValue(tracked);
  const liveness = new Map([["mat_dead", "dead" as const]]);
  const deadSinceByHash = new Map([[hashValue("mat_dead"), "2026-09-01T00:00:00.000Z"]]);

  const report = buildReport(groups, liveness, deadSinceByHash, "2026-09-28T00:00:00.000Z");

  assert.equal(report.deadEntries.length, 2);
  assert.ok(report.deadEntries.every((e) => e.deadSince === "2026-09-01T00:00:00.000Z"));
  const refEntry = report.deadEntries.find((e) => e.name === "B");
  assert.equal(refEntry?.referenceTarget, "prod.mdrag.A");
});

test("buildReport: a dead value with no prior state gets deadSince = now", () => {
  const tracked = trackSecrets([rec({ name: "A", value: "mat_newlydead", rawValue: "mat_newlydead" })]);
  const groups = groupByValue(tracked);
  const liveness = new Map([["mat_newlydead", "dead" as const]]);

  const report = buildReport(groups, liveness, new Map(), "2026-09-28T00:00:00.000Z");
  assert.equal(report.deadEntries[0].deadSince, "2026-09-28T00:00:00.000Z");
});

test("buildReport: a live value produces no dead entries", () => {
  const tracked = trackSecrets([rec({ name: "A", value: "mat_alive", rawValue: "mat_alive" })]);
  const groups = groupByValue(tracked);
  const liveness = new Map([["mat_alive", "live" as const]]);

  const report = buildReport(groups, liveness, new Map(), "2026-09-28T00:00:00.000Z");
  assert.equal(report.deadEntries.length, 0);
  assert.equal(report.unknownEntries.length, 0);
});

test("buildReport: a value missing from the liveness map is 'unknown', not silently dropped", () => {
  const tracked = trackSecrets([rec({ name: "A", value: "mat_uncertain", rawValue: "mat_uncertain" })]);
  const groups = groupByValue(tracked);

  const report = buildReport(groups, new Map(), new Map(), "2026-09-28T00:00:00.000Z");
  assert.equal(report.deadEntries.length, 0);
  assert.equal(report.unknownEntries.length, 1);
  assert.equal(report.unknownEntries[0].name, "A");
});

// ---------------------------------------------------------------------------
// updateDeadSinceState
// ---------------------------------------------------------------------------

test("updateDeadSinceState: keeps the original deadSince for a value still dead", () => {
  const prev = { [hashValue("mat_x")]: "2026-09-01T00:00:00.000Z" };
  const next = updateDeadSinceState(prev, ["mat_x"], "2026-09-28T00:00:00.000Z");
  assert.equal(next[hashValue("mat_x")], "2026-09-01T00:00:00.000Z");
});

test("updateDeadSinceState: adds a newly-dead value at now", () => {
  const next = updateDeadSinceState({}, ["mat_new"], "2026-09-28T00:00:00.000Z");
  assert.equal(next[hashValue("mat_new")], "2026-09-28T00:00:00.000Z");
});

test("updateDeadSinceState: drops a value that recovered", () => {
  const prev = { [hashValue("mat_recovered")]: "2026-09-01T00:00:00.000Z" };
  const next = updateDeadSinceState(prev, [], "2026-09-28T00:00:00.000Z");
  assert.deepEqual(next, {});
});

// ---------------------------------------------------------------------------
// formatAlertMessage
// ---------------------------------------------------------------------------

test("formatAlertMessage: null when nothing is dead (duplicates/unknowns alone don't alert)", () => {
  const report = buildReport(
    groupByValue(trackSecrets([rec({ name: "A", value: "mat_alive", rawValue: "mat_alive" })])),
    new Map([["mat_alive", "live" as const]]),
    new Map(),
    "2026-09-28T00:00:00.000Z"
  );
  assert.equal(formatAlertMessage(report), null);
});

test("formatAlertMessage: never includes a full token value, only the 4-char prefix", () => {
  const tracked = trackSecrets([rec({ name: "A", value: "mat_verysecretvalue", rawValue: "mat_verysecretvalue" })]);
  const report = buildReport(
    groupByValue(tracked),
    new Map([["mat_verysecretvalue", "dead" as const]]),
    new Map(),
    "2026-09-28T00:00:00.000Z"
  );
  const message = formatAlertMessage(report);
  assert.ok(message);
  assert.ok(!message.includes("verysecretvalue"));
  assert.ok(message.includes("mat_"));
  assert.ok(message.includes("A"));
});
