import assert from "node:assert/strict";
import { test } from "node:test";
import { completeViaLettaGateway } from "./letta-gateway.js";

type FetchCall = { url: string; init?: RequestInit };

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!r) throw new Error("fakeFetch called with no responses configured");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  };
  return { fn, calls };
}

async function withFakeFetch<T>(
  responses: Array<{ status: number; body: unknown }>,
  run: (calls: FetchCall[]) => Promise<T>
): Promise<T> {
  const { fn, calls } = fakeFetch(responses);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("completeViaLettaGateway returns the first choice's content on success", async () => {
  const text = await withFakeFetch(
    [{ status: 200, body: { choices: [{ message: { content: "hi there" } }] } }],
    async () => completeViaLettaGateway("hello")
  );
  assert.equal(text, "hi there");
});

test("completeViaLettaGateway sends ephemeral: true and a single user message", async () => {
  await withFakeFetch(
    [{ status: 200, body: { choices: [{ message: { content: "ok" } }] } }],
    async (calls) => {
      await completeViaLettaGateway("system\n\nuser text");
      const body = JSON.parse(calls[0]?.init?.body as string);
      assert.equal(body.ephemeral, true);
      assert.deepEqual(body.messages, [{ role: "user", content: "system\n\nuser text" }]);
    }
  );
});

test("completeViaLettaGateway sends a dc_ bearer when DATACREW_API_TOKEN is set", async () => {
  const original = process.env.DATACREW_API_TOKEN;
  process.env.DATACREW_API_TOKEN = "dc_test-token";
  try {
    await withFakeFetch(
      [{ status: 200, body: { choices: [{ message: { content: "ok" } }] } }],
      async (calls) => {
        await completeViaLettaGateway("hello");
        const headers = calls[0]?.init?.headers as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer dc_test-token");
      }
    );
  } finally {
    if (original === undefined) delete process.env.DATACREW_API_TOKEN;
    else process.env.DATACREW_API_TOKEN = original;
  }
});

test("completeViaLettaGateway throws on a non-2xx response", async () => {
  await withFakeFetch([{ status: 502, body: { error: "bad gateway" } }], async () => {
    await assert.rejects(() => completeViaLettaGateway("hello"), /Letta gateway error: 502/);
  });
});

test("completeViaLettaGateway throws when the response has no choices", async () => {
  await withFakeFetch([{ status: 200, body: { choices: [] } }], async () => {
    await assert.rejects(() => completeViaLettaGateway("hello"), /Letta gateway returned no choices/);
  });
});
