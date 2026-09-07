import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationAgentReply, resolveBackend } from "./conversation-agent.js";

function fakeFetch(handlers: {
  gateway?: (init?: RequestInit) => Promise<Response> | Response;
  letta?: (init?: RequestInit) => Promise<Response> | Response;
}) {
  return async (url: string, init?: RequestInit) => {
    if (url.includes("letta-shim")) {
      if (!handlers.letta) throw new Error(`unexpected letta-gateway call: ${url}`);
      return handlers.letta(init);
    }
    if (!handlers.gateway) throw new Error(`unexpected completion-gateway call: ${url}`);
    return handlers.gateway(init);
  };
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
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(handlers) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// PATTERN_HUNTER_AGENT_BACKEND is read into a module-level constant at
// import time (matching every other env-configured default in this project —
// GATEWAY_URL, MODEL, etc.), not re-read per call, so it can't be exercised
// by mutating process.env within a test the way DATACREW_API_TOKEN can
// below (that one IS read fresh per call, by resolveDatacrewToken()). This
// suite only asserts the request-level override and the process's actual
// default (whatever PATTERN_HUNTER_AGENT_BACKEND was — or wasn't — set to
// when this test file's module graph was imported).

test("resolveBackend: an explicit request-level backend always wins, regardless of the process default", () => {
  assert.equal(resolveBackend("claude"), "claude");
  assert.equal(resolveBackend("letta"), "letta");
});

test("resolveBackend: 'auto' with no env override resolves to 'claude'", () => {
  // True whenever PATTERN_HUNTER_AGENT_BACKEND is unset in this process,
  // which is the case for a plain `npm test` run.
  if (process.env.PATTERN_HUNTER_AGENT_BACKEND) return;
  assert.equal(resolveBackend(), "claude");
  assert.equal(resolveBackend("auto"), "claude");
});

test("conversationAgentReply: 'claude' backend calls the completion gateway", async () => {
  const result = await withFakeFetch(
    { gateway: () => jsonResponse(200, { choices: [{ message: { content: "claude says hi" } }] }) },
    () => conversationAgentReply({ systemPrompt: "sys", userPrompt: "user", backend: "claude" })
  );
  assert.equal(result.backend, "claude");
  assert.equal(result.text, "claude says hi");
});

test("conversationAgentReply: 'letta' backend calls the letta gateway in ephemeral mode", async () => {
  const result = await withFakeFetch(
    {
      letta: (init) => {
        const body = JSON.parse(init?.body as string);
        assert.equal(body.ephemeral, true);
        assert.deepEqual(body.messages, [{ role: "user", content: "sys\n\nuser" }]);
        return jsonResponse(200, { choices: [{ message: { content: "letta says hi" } }] });
      },
    },
    () => conversationAgentReply({ systemPrompt: "sys", userPrompt: "user", backend: "letta" })
  );
  assert.equal(result.backend, "letta");
  assert.equal(result.text, "letta says hi");
});

test("conversationAgentReply: 'claude' backend sends a dc_ bearer, never api.anthropic.com", async () => {
  const original = process.env.DATACREW_API_TOKEN;
  process.env.DATACREW_API_TOKEN = "dc_test-token";
  try {
    await withFakeFetch(
      {
        gateway: (init) => {
          const headers = init?.headers as Record<string, string>;
          assert.equal(headers.Authorization, "Bearer dc_test-token");
          return jsonResponse(200, { choices: [{ message: { content: "ok" } }] });
        },
      },
      () => conversationAgentReply({ systemPrompt: "sys", userPrompt: "user", backend: "claude" })
    );
  } finally {
    if (original === undefined) delete process.env.DATACREW_API_TOKEN;
    else process.env.DATACREW_API_TOKEN = original;
  }
});
