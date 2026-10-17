import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INTERNAL_SECRET_REF,
  MDRAG_DIRECT_URL,
  STUCK_RUNS,
  SweepRequestError,
  nextSweepState,
  runHuntReporterSweep,
  sweepBaseUrl,
} from "./huntReporterSweepCore.js";

const call = { url: "http://mdrag-local:8017/api/v1/internal/hunt-reporter/sweep", headers: { "X-Internal-Secret": "s" } };
const reply = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;

function run(body: unknown, prev: { consecutiveBehind?: number; consecutiveFailed?: number } | null, status = 200) {
  const warnings: string[] = [];
  const out = runHuntReporterSweep({
    call,
    fetchImpl: reply(status, body),
    previous: async () => prev,
    warn: (m) => warnings.push(m),
  });
  return { out, warnings };
}

describe("hunt reporter sweep", () => {
  it("resets counters when nothing is behind or failed", () => {
    assert.deepEqual(nextSweepState({ checked: 3, behind: 0, failed: [] }, { consecutiveBehind: 4, consecutiveFailed: 2 }), {
      consecutiveBehind: 0,
      consecutiveFailed: 0,
    });
  });

  it("stays quiet below the threshold", async () => {
    const { out, warnings } = run({ checked: 2, behind: 1, failed: [] }, { consecutiveBehind: STUCK_RUNS - 2 });
    assert.equal((await out).consecutiveBehind, STUCK_RUNS - 1);
    assert.deepEqual(warnings, []);
  });

  it("warns once behind has persisted", async () => {
    const { out, warnings } = run({ checked: 2, behind: 1, failed: [] }, { consecutiveBehind: STUCK_RUNS - 1 });
    assert.equal((await out).consecutiveBehind, STUCK_RUNS);
    assert.equal(warnings.length, 1);
  });

  it("warns when failed hunts persist", async () => {
    const { warnings, out } = run({ checked: 2, behind: 0, failed: ["h1"] }, { consecutiveFailed: STUCK_RUNS - 1 });
    await out;
    assert.equal(warnings.length, 1);
  });

  it("treats a first run (no previous) as one", async () => {
    const { out } = run({ checked: 1, behind: 1, failed: [] }, null);
    assert.equal((await out).consecutiveBehind, 1);
  });

  it("throws on a non-2xx so the run fails", async () => {
    await assert.rejects(run("nope", null, 403).out, SweepRequestError);
  });

  it("throws on a malformed body", async () => {
    await assert.rejects(run({ checked: 1 }, null).out, SweepRequestError);
  });

  it("defaults to mdrag's direct address, never the wiki", () => {
    assert.equal(sweepBaseUrl({}), MDRAG_DIRECT_URL);
    assert.equal(sweepBaseUrl({ MDRAG_URL: "  " }), MDRAG_DIRECT_URL);
    assert.notEqual(new URL(MDRAG_DIRECT_URL).hostname, "wiki.datacrew.space");
  });

  it("lets MDRAG_URL override the default, trailing slash trimmed", () => {
    assert.equal(sweepBaseUrl({ MDRAG_URL: "http://localhost:8017/" }), "http://localhost:8017");
  });

  it("reads mdrag's own INTERNAL_SECRET, not a name that does not exist", () => {
    assert.equal(INTERNAL_SECRET_REF.key, "INTERNAL_SECRET");
  });
});
