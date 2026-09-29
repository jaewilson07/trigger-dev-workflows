import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CloudflareGraphqlError,
  MissingAnalyticsTokenError,
  decideQuota,
  fetchHeavyClients,
  fetchInvocationsToday,
  makeGraphqlFetch,
  runQuotaCheck,
} from "./cfAnalytics.js";
import type { GraphqlFetch, QuotaState } from "./cfAnalytics.js";

const NOW = new Date("2026-09-29T15:07:00Z");

function invocations(n: number) {
  return { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: n - 5 } }, { sum: { requests: 5 } }] }] } };
}
function clients(rows: Array<[string, string, number]>) {
  return {
    viewer: { zones: [{ httpRequestsAdaptiveGroups: rows.map(([clientIP, userAgent, count]) => ({ count, dimensions: { clientIP, userAgent } })) }] },
  };
}

test("fetchInvocationsToday sums rows and queries from UTC midnight", async () => {
  let vars: Record<string, string> = {};
  const gql: GraphqlFetch = async (_q, v) => {
    vars = v;
    return invocations(61_000);
  };
  assert.equal(await fetchInvocationsToday(gql, "acc", NOW), 61_000);
  assert.equal(vars.start, "2026-09-29T00:00:00.000Z");
  assert.equal(vars.account, "acc");
});

test("missing account data is a loud error", async () => {
  await assert.rejects(fetchInvocationsToday(async () => ({ viewer: { accounts: [] } }), "acc", NOW), CloudflareGraphqlError);
});

test("heavy clients aggregate per IP across user agents and keep the top UA", async () => {
  const gql: GraphqlFetch = async () =>
    clients([["1.2.3.4", "curl/8", 3000], ["1.2.3.4", "python-requests", 2500], ["5.6.7.8", "Mozilla", 4000]]);
  const heavy = await fetchHeavyClients(gql, "zone", NOW);
  assert.deepEqual(heavy, [{ ip: "1.2.3.4", requests: 5500, userAgent: "curl/8" }]);
});

test("thresholds alert once each: 60k, then 80k, never repeated the same day", () => {
  const a = decideQuota(null, 61_000, [], NOW);
  assert.equal(a.messages.length, 1);
  assert.match(a.messages[0], /60,000/);
  const b = decideQuota(a.state, 62_000, [], NOW);
  assert.equal(b.messages.length, 0);
  const c = decideQuota(b.state, 81_000, [], NOW);
  assert.equal(c.messages.length, 1);
  assert.match(c.messages[0], /80,000/);
});

test("jumping straight past both thresholds sends one message", () => {
  assert.equal(decideQuota(null, 85_000, [], NOW).messages.length, 1);
});

test("below threshold is silent; a new UTC day resets flags", () => {
  assert.equal(decideQuota(null, 59_999, [], NOW).messages.length, 0);
  const yesterday: QuotaState = { date: "2026-09-28", levelsAlerted: [60_000, 80_000], ipsAlerted: ["1.2.3.4"] };
  const d = decideQuota(yesterday, 61_000, [{ ip: "1.2.3.4", requests: 6000, userAgent: "curl/8" }], NOW);
  assert.equal(d.messages.length, 2);
  assert.match(d.messages[1], /1\.2\.3\.4: 6,000 requests, UA: curl\/8/);
});

test("runQuotaCheck notifies per message and returns updated state", async () => {
  const sent: string[] = [];
  const gql: GraphqlFetch = async (q) => (q.includes("workersInvocationsAdaptive") ? invocations(70_000) : clients([["9.9.9.9", "bot", 9000]]));
  const result = await runQuotaCheck({ gql, accountId: "a", zoneId: "z", previous: async () => null, notify: async (t) => void sent.push(t), now: NOW });
  assert.equal(sent.length, 2);
  assert.deepEqual(result.state.levelsAlerted, [60_000]);
  assert.deepEqual(result.state.ipsAlerted, ["9.9.9.9"]);
});

test("GraphQL errors (e.g. code 10000 auth) throw naming the token", async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ data: null, errors: [{ message: "authentication error", extensions: { code: "10000" } }] }), { status: 200 })) as typeof fetch;
  await assert.rejects(makeGraphqlFetch("t", fake)("q", {}), /Analytics:Read/);
});

test("MissingAnalyticsTokenError names the secret and both scopes", () => {
  const msg = new MissingAnalyticsTokenError().message;
  assert.match(msg, /CF_ANALYTICS_TOKEN/);
  assert.match(msg, /Account Analytics/);
  assert.match(msg, /datacrew\.space/);
});
