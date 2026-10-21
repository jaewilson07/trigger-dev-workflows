import assert from "node:assert/strict";
import { test } from "node:test";
import { createOverrideResolver } from "./letta-override.js";

function resolverWith(handler: (url: string) => Response | Promise<Response>, now = () => 0) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const resolve = createOverrideResolver({
    baseUrl: "https://letta.test",
    apiKey: "k",
    ttlMs: 60_000,
    now,
    warn: (m) => warnings.push(m),
    fetchImpl: (async (url: string) => {
      calls.push(url);
      return handler(url);
    }) as unknown as typeof fetch,
  });
  return { resolve, calls, warnings };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

test("agent on house-model fallback gets no override", async () => {
  const { resolve } = resolverWith(() =>
    json({ metadata: { auto_fallback: { previous: "letta/auto", switched_at: "t", resets_at: "t2" } } })
  );
  assert.equal(await resolve("agent-1", "letta/auto-fast"), undefined);
});

test("agent without the record keeps its override", async () => {
  const { resolve } = resolverWith(() => json({ metadata: {} }));
  assert.equal(await resolve("agent-1", "letta/auto-fast"), "letta/auto-fast");
  const none = resolverWith(() => json({}));
  assert.equal(await none.resolve("agent-1", "letta/auto-fast"), "letta/auto-fast");
});

test("failed metadata read keeps the override and warns", async () => {
  const bad = resolverWith(() => new Response("boom", { status: 500 }));
  assert.equal(await bad.resolve("agent-1", "letta/auto-fast"), "letta/auto-fast");
  assert.equal(bad.warnings.length, 1);
  const thrown = resolverWith(() => {
    throw new Error("network down");
  });
  assert.equal(await thrown.resolve("agent-1", "letta/auto-fast"), "letta/auto-fast");
  assert.equal(thrown.warnings.length, 1);
});

test("result is cached per agent for the ttl", async () => {
  let t = 0;
  const { resolve, calls } = resolverWith(() => json({ metadata: {} }), () => t);
  await resolve("agent-1", "m");
  await resolve("agent-1", "m");
  assert.equal(calls.length, 1);
  await resolve("agent-2", "m");
  assert.equal(calls.length, 2);
  t = 61_000;
  await resolve("agent-1", "m");
  assert.equal(calls.length, 3);
});

test("conversation ids resolve through their agent", async () => {
  const { resolve, calls } = resolverWith((url) =>
    url.includes("/v1/conversations/")
      ? json({ agent_id: "agent-9" })
      : json({ metadata: { auto_fallback: {} } })
  );
  assert.equal(await resolve({ conversationId: "conv-1" }, "letta/auto-fast"), undefined);
  assert.deepEqual(calls, [
    "https://letta.test/v1/conversations/conv-1",
    "https://letta.test/v1/agents/agent-9",
  ]);
});
