import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLiveness, checkLivenessForGroups } from "./tokenHealthLiveness.js";
import type { ValueGroup } from "./tokenHealthCore.js";

test("checkLiveness: 401 is dead", async () => {
  const fakeFetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
  assert.equal(await checkLiveness("mat_x", fakeFetch), "dead");
});

test("checkLiveness: 200 is live", async () => {
  const fakeFetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  assert.equal(await checkLiveness("mat_x", fakeFetch), "live");
});

test("checkLiveness: an unrelated error status is 'unknown', not a false dead", async () => {
  const fakeFetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
  assert.equal(await checkLiveness("mat_x", fakeFetch), "unknown");
});

test("checkLiveness: a network failure is 'unknown', never throws", async () => {
  const fakeFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  assert.equal(await checkLiveness("mat_x", fakeFetch), "unknown");
});

test("checkLiveness: sends the value as a Bearer token, never elsewhere", async () => {
  let seenAuth: string | null = null;
  const fakeFetch = (async (_url, init) => {
    seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  await checkLiveness("mat_verysecret", fakeFetch);
  assert.equal(seenAuth, "Bearer mat_verysecret");
});

test("checkLivenessForGroups: calls the checker exactly once per distinct group", async () => {
  const calls: string[] = [];
  const groups: ValueGroup[] = [
    { value: "mat_a", prefix: "mat", entries: [] },
    { value: "dc_b", prefix: "dc", entries: [] },
  ];
  const result = await checkLivenessForGroups(groups, async (value) => {
    calls.push(value);
    return "live";
  });
  assert.deepEqual(calls, ["mat_a", "dc_b"]);
  assert.equal(result.get("mat_a"), "live");
  assert.equal(result.get("dc_b"), "live");
});
