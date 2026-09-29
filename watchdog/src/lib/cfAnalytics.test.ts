import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CloudflareGraphqlError,
  MissingAnalyticsTokenError,
  PagesQueryError,
  decideQuota,
  fetchHeavyClients,
  fetchInvocationsToday,
  isSecretNotFound,
  makeGraphqlFetch,
  runQuotaCheck,
} from "./cfAnalytics.js";
import type { GraphqlFetch, QuotaState } from "./cfAnalytics.js";

const NOW = new Date("2026-09-29T15:07:00Z");

function invocations(n: number, pages = 0) {
  return {
    viewer: {
      accounts: [
        {
          workersInvocationsAdaptive: [{ sum: { requests: n - 5 } }, { sum: { requests: 5 } }],
          pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: pages } }],
        },
      ],
    },
  };
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
  assert.deepEqual(await fetchInvocationsToday(gql, "acc", NOW), { workers: 61_000, pages: 0, total: 61_000 });
  assert.equal(vars.start, "2026-09-29T00:00:00.000Z");
  assert.equal(vars.account, "acc");
});

test("Pages Functions invocations are summed with Workers", async () => {
  const gql: GraphqlFetch = async (q) => (q.includes("pagesFunctions") ? invocations(0, 30_000) : invocations(31_000));
  assert.deepEqual(await fetchInvocationsToday(gql, "acc", NOW), { workers: 31_000, pages: 30_000, total: 61_000 });
});

test("zero combined count while the site is up alerts once that the query is blind", () => {
  const a = decideQuota(null, 0, [], NOW, true);
  assert.equal(a.messages.length, 1);
  assert.match(a.messages[0], /blind/);
  assert.equal(decideQuota(a.state, 0, [], NOW, true).messages.length, 0);
  assert.equal(decideQuota(null, 0, [], NOW, false).messages.length, 0);
  assert.equal(decideQuota(null, 0, [], NOW, null).messages.length, 0);
});

test("no blind alert in the first 2h of the UTC day, even with zero invocations", () => {
  const midnight = new Date("2026-09-30T00:10:00Z");
  assert.equal(decideQuota(null, 0, [], midnight, true).messages.length, 0);
  assert.equal(decideQuota(null, 0, [], new Date("2026-09-30T01:59:00Z"), true).messages.length, 0);
  assert.equal(decideQuota(null, 0, [], new Date("2026-09-30T02:00:00Z"), true).messages.length, 1);
});

test("Pages failure: run completes with state persisted, Workers alert sent once, heavy-IP check still runs, cause attached", async () => {
  const sent: string[] = [];
  const gql: GraphqlFetch = async (q) => {
    if (q.includes("PagesInvocations")) throw new Error("unknown field");
    if (q.includes("TopClients")) return clients([["9.9.9.9", "bot", 9000]]);
    return invocations(65_000);
  };
  const deps = { gql, accountId: "a", zoneId: "z", siteUp: async () => null, notify: async (t: string) => void sent.push(t), now: NOW };
  const first = await runQuotaCheck({ ...deps, previous: async () => null });
  assert.match(first.pagesError ?? "", /Workers count was 65000/);
  assert.deepEqual(first.state.levelsAlerted, [60_000]);
  assert.deepEqual(first.state.ipsAlerted, ["9.9.9.9"]);
  assert.equal(sent.length, 3); // pages-error notice, 60k threshold, heavy IP
  // The next run reads the persisted state and re-sends nothing.
  sent.length = 0;
  const second = await runQuotaCheck({ ...deps, previous: async () => first.state });
  assert.equal(second.alerts, 0);
  assert.equal(sent.length, 0);
});

test("PagesQueryError carries the original error as cause", () => {
  const original = new Error("boom");
  assert.equal(new PagesQueryError(1, original).cause, original);
});

test("only a genuinely absent secret counts as not found", () => {
  assert.equal(isSecretNotFound(new Error("Secret CF_ANALYTICS_TOKEN not found in Infisical /datacrew")), true);
  assert.equal(isSecretNotFound(new Error("Infisical auth failed: 401")), false);
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
  const gql: GraphqlFetch = async (q) => (q.includes("Invocations") ? invocations(70_000) : clients([["9.9.9.9", "bot", 9000]]));
  const result = await runQuotaCheck({ gql, accountId: "a", zoneId: "z", previous: async () => null, siteUp: async () => null, notify: async (t) => void sent.push(t), now: NOW });
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
