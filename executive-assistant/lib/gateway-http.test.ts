import assert from "node:assert/strict";
import { test } from "node:test";
import { postChatCompletion } from "./gateway-http.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

async function withFakeFetch<T>(response: Response, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("postChatCompletion returns the first choice's content on success", async () => {
  const text = await withFakeFetch(
    jsonResponse(200, { choices: [{ message: { content: "hi" } }] }),
    () => postChatCompletion("http://x", {}, {}, 1000, "X gateway")
  );
  assert.equal(text, "hi");
});

test("postChatCompletion throws a labeled error on a non-2xx response", async () => {
  await withFakeFetch(jsonResponse(500, { error: "boom" }), async () => {
    await assert.rejects(
      () => postChatCompletion("http://x", {}, {}, 1000, "X gateway"),
      /X gateway error: 500/
    );
  });
});

test("postChatCompletion throws a labeled error when choices is empty", async () => {
  await withFakeFetch(jsonResponse(200, { choices: [] }), async () => {
    await assert.rejects(
      () => postChatCompletion("http://x", {}, {}, 1000, "X gateway"),
      /X gateway returned no choices/
    );
  });
});

// /code-review finding: `data.choices[0]?.message.content` guarded against
// an empty array but not a choice object present without a `message` field,
// throwing a raw TypeError instead of the intended controlled error.
test("postChatCompletion throws a labeled error (not a TypeError) when a choice has no message", async () => {
  await withFakeFetch(jsonResponse(200, { choices: [{}] }), async () => {
    await assert.rejects(
      () => postChatCompletion("http://x", {}, {}, 1000, "X gateway"),
      /X gateway returned no choices/
    );
  });
});
