import assert from "node:assert/strict";
import { test } from "node:test";
import { completeText } from "./mermaid-llm.js";

// Both completion-gateway.ts and letta-gateway.ts hit `GATEWAY_URL`/
// `LETTA_GATEWAY_URL` — distinguish the two fakes by URL rather than by
// import, matching this suite's existing fetch-fake convention
// (mdrag-job-poll.test.ts) since mermaid-llm.ts doesn't expose its two
// collaborators for direct injection.
function fakeFetch(handlers: {
  gateway?: (init?: RequestInit) => Promise<Response> | Response;
  letta?: (init?: RequestInit) => Promise<Response> | Response;
}) {
  const calls: string[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes("letta-shim")) {
      if (!handlers.letta) throw new Error(`unexpected letta-gateway call: ${url}`);
      return handlers.letta(init);
    }
    if (!handlers.gateway) throw new Error(`unexpected completion-gateway call: ${url}`);
    return handlers.gateway(init);
  };
  return { fn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

async function withFakeFetch<T>(
  handlers: Parameters<typeof fakeFetch>[0],
  run: (calls: string[]) => Promise<T>
): Promise<T> {
  const { fn, calls } = fakeFetch(handlers);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("completeText returns the completion gateway's reply when it succeeds", async () => {
  const text = await withFakeFetch(
    { gateway: () => jsonResponse(200, { choices: [{ message: { content: "gateway reply" } }] }) },
    async () => completeText("system", "user")
  );
  assert.equal(text, "gateway reply");
});

// The letta-gateway fallback is only attempted when isLettaGatewayConfigured()
// sees a dc_ token (fast-fail guard, /code-review finding) — set one for
// every test below that expects the fallback to actually run.
async function withDatacrewToken<T>(run: () => Promise<T>): Promise<T> {
  const original = process.env.DATACREW_API_TOKEN;
  process.env.DATACREW_API_TOKEN = "dc_test-token";
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.DATACREW_API_TOKEN;
    else process.env.DATACREW_API_TOKEN = original;
  }
}

test("completeText falls back to the letta gateway (ephemeral) when the completion gateway fails", async () => {
  const text = await withDatacrewToken(() =>
    withFakeFetch(
      {
        gateway: () => jsonResponse(500, { error: "gateway down" }),
        letta: () => jsonResponse(200, { choices: [{ message: { content: "letta reply" } }] }),
      },
      async () => completeText("system", "user")
    )
  );
  assert.equal(text, "letta reply");
});

test("completeText's letta-gateway fallback folds system+user into one message, marked ephemeral", async () => {
  await withDatacrewToken(() =>
    withFakeFetch(
      {
        gateway: () => jsonResponse(500, { error: "gateway down" }),
        letta: (init) => {
          const body = JSON.parse(init?.body as string);
          assert.equal(body.ephemeral, true);
          assert.deepEqual(body.messages, [{ role: "user", content: "sys prompt\n\nuser prompt" }]);
          return jsonResponse(200, { choices: [{ message: { content: "letta reply" } }] });
        },
      },
      async () => completeText("sys prompt", "user prompt")
    )
  );
});

test("completeText propagates the letta-gateway's own error when both backends fail", async () => {
  await withDatacrewToken(() =>
    withFakeFetch(
      {
        gateway: () => jsonResponse(500, { error: "gateway down" }),
        letta: () => jsonResponse(502, { error: "letta down too" }),
      },
      async () => {
        await assert.rejects(() => completeText("system", "user"), /Letta gateway error: 502/);
      }
    )
  );
});

test("completeText fails fast with the gateway's own error when no dc_ token is set, never calling the letta gateway", async () => {
  const original = process.env.DATACREW_API_TOKEN;
  delete process.env.DATACREW_API_TOKEN;
  try {
    await withFakeFetch(
      {
        gateway: () => jsonResponse(500, { error: "gateway down" }),
        letta: () => {
          throw new Error("letta gateway should never be called when unconfigured");
        },
      },
      async () => {
        await assert.rejects(() => completeText("system", "user"), /Completion gateway error: 500/);
      }
    );
  } finally {
    if (original === undefined) delete process.env.DATACREW_API_TOKEN;
    else process.env.DATACREW_API_TOKEN = original;
  }
});
