import assert from "node:assert/strict";
import { test } from "node:test";
import { pollMdragJob } from "./mdrag-job-poll.js";

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

test("pollMdragJob returns documentUid immediately when the first poll is already finished", async () => {
  const { fn, calls } = fakeFetch([
    { status: 200, body: { status: "finished", result: { documents: [{ document_uid: "doc-1" }] } } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const result = await pollMdragJob("https://wiki.datacrew.space", "/api/v1/jobs/job-1", "tok");
    assert.deepEqual(result, {
      ok: true,
      documentUid: "doc-1",
      result: { documents: [{ document_uid: "doc-1" }] },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://wiki.datacrew.space/api/v1/jobs/job-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pollMdragJob keeps polling through queued/started and stops on finished", async () => {
  const { fn, calls } = fakeFetch([
    { status: 200, body: { status: "queued" } },
    { status: 200, body: { status: "started" } },
    { status: 200, body: { status: "finished", result: { documents: [{ document_uid: "doc-2" }] } } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const result = await pollMdragJob("https://wiki.datacrew.space", "/api/v1/jobs/job-2", "tok", {
      intervalMs: 1,
    });
    assert.equal(result.ok, true);
    assert.equal((result as { documentUid: string | null }).documentUid, "doc-2");
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pollMdragJob surfaces a failed job's error without throwing", async () => {
  const { fn } = fakeFetch([{ status: 200, body: { status: "failed", error: "docling parse error" } }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const result = await pollMdragJob("https://wiki.datacrew.space", "/api/v1/jobs/job-3", "tok");
    assert.deepEqual(result, { ok: false, error: "docling parse error" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pollMdragJob surfaces a non-2xx status check as an error", async () => {
  const { fn } = fakeFetch([{ status: 500, body: "internal error" }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const result = await pollMdragJob("https://wiki.datacrew.space", "/api/v1/jobs/job-4", "tok");
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /job status check failed: 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pollMdragJob times out with a descriptive error when the job never reaches a terminal state", async () => {
  const { fn } = fakeFetch([{ status: 200, body: { status: "started" } }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const result = await pollMdragJob("https://wiki.datacrew.space", "/api/v1/jobs/job-5", "tok", {
      intervalMs: 5,
      timeoutMs: 10,
    });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /did not reach a terminal state/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
