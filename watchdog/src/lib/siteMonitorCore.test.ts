import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, runChecks, runSiteCheck, SITE_CHECKS } from "./siteMonitorCore.js";
import type { Probe, ProbeResult } from "./siteMonitorCore.js";

const HSTS = "max-age=63072000";

function healthyProbe(overrides: Record<string, Partial<ProbeResult>> = {}): Probe {
  return async (url) => {
    const base: ProbeResult = { url, finalUrl: url, status: 200, hsts: HSTS, body: null };
    if (url.endsWith("/api/sso/nope")) Object.assign(base, { status: 404 });
    if (url.includes("/packages/dc-auth/")) {
      Object.assign(base, { finalUrl: "https://packages.datacrew.space/dc-auth/", body: "<a>dc-auth-0.1.0.tar.gz</a>" });
    }
    return { ...base, ...(overrides[url] ?? {}) };
  };
}

test("all app-only signals present passes", async () => {
  const out = await runChecks(healthyProbe());
  assert.deepEqual(out.map((o) => o.ok), [true, true, true]);
});

test("static fallback 404 on / fails (not 200)", async () => {
  const out = await runChecks(healthyProbe({ "https://datacrew.space/": { status: 404, hsts: null } }));
  assert.equal(out[0].ok, false);
  assert.match(out[0].reason ?? "", /expected 200, got 404/);
});

test("200 without HSTS fails as static fallback", async () => {
  const out = await runChecks(healthyProbe({ "https://datacrew.space/": { hsts: null } }));
  assert.match(out[0].reason ?? "", /Strict-Transport-Security/);
});

test("the /api/sso/nope 404 without HSTS fails; the same 404 with HSTS passes", async () => {
  const url = "https://datacrew.space/api/sso/nope";
  assert.equal((await runChecks(healthyProbe({ [url]: { hsts: null } })))[1].ok, false);
  assert.equal((await runChecks(healthyProbe()))[1].ok, true);
});

test("package index must list dc-auth-0.1.0 after redirects", async () => {
  const url = "https://datacrew.space/packages/dc-auth/";
  const out = await runChecks(healthyProbe({ [url]: { body: "<html>nothing</html>" } }));
  assert.match(out[2].reason ?? "", /does not list dc-auth-0\.1\.0/);
});

test("network error becomes a failed check, not a throw", async () => {
  const probe: Probe = async (url) => ({ url, finalUrl: url, status: 0, hsts: null, body: null, error: "ETIMEDOUT" });
  const out = await runChecks(probe, SITE_CHECKS);
  assert.ok(out.every((o) => !o.ok));
  assert.match(out[0].reason ?? "", /ETIMEDOUT/);
});

const failing = [{ name: "home", url: "https://datacrew.space/", ok: false, reason: "expected 200, got 404" }];
const passing = [{ name: "home", url: "https://datacrew.space/", ok: true, reason: null }];

test("debounce: first failure is silent, second alerts, third is silent", () => {
  const first = decide({ consecutiveFailures: 0 }, failing);
  assert.equal(first.decision.action, "none");
  const second = decide(first.state, failing);
  assert.equal(second.decision.action, "alert");
  assert.equal(decide(second.state, failing).decision.action, "none");
});

test("re-alerts every 12 runs while down, then sends one recovery", () => {
  assert.equal(decide({ consecutiveFailures: 13 }, failing).decision.action, "alert");
  assert.equal(decide({ consecutiveFailures: 5 }, passing).decision.action, "recovered");
  assert.equal(decide({ consecutiveFailures: 1 }, passing).decision.action, "none");
});

test("runSiteCheck notifies only on alert and returns new count", async () => {
  const sent: string[] = [];
  const probe: Probe = async (url) => ({ url, finalUrl: url, status: 404, hsts: null, body: null });
  const result = await runSiteCheck({ probe, previous: async () => ({ consecutiveFailures: 1 }), notify: async (t) => void sent.push(t) });
  assert.equal(result.consecutiveFailures, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /datacrew-site#241/);
});
