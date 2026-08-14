import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestMdragText } from "./mdrag-text-ingest.js";

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

test("ingestMdragText always sets async_mode on the enqueue request", async () => {
  const { fn, calls } = fakeFetch([
    { status: 202, body: { job_id: "job-1", status: "queued", status_url: "/api/v1/jobs/job-1" } },
    { status: 200, body: { status: "finished", result: { documents: [{ document_uid: "doc-1" }] } } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    await ingestMdragText({
      baseUrl: "https://wiki.datacrew.space",
      token: "tok",
      content: "hello",
    });
    const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
    assert.equal(body.async_mode, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingestMdragText includes optional fields only when supplied", async () => {
  const { fn, calls } = fakeFetch([
    { status: 202, body: { job_id: "job-1", status: "queued", status_url: "/api/v1/jobs/job-1" } },
    { status: 200, body: { status: "finished", result: { documents: [{ document_uid: "doc-1" }] } } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    await ingestMdragText({
      baseUrl: "https://wiki.datacrew.space",
      token: "tok",
      content: "hello",
    });
    const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
    assert.equal("collection_id" in body, false);
    assert.equal("source_group" in body, false);
    assert.equal("title" in body, false);
    assert.equal("metadata" in body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingestMdragText sends collection id, source group, title, and metadata when the caller supplies them", async () => {
  const { fn, calls } = fakeFetch([
    { status: 202, body: { job_id: "job-1", status: "queued", status_url: "/api/v1/jobs/job-1" } },
    { status: 200, body: { status: "finished", result: { documents: [{ document_uid: "doc-1" }] } } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    await ingestMdragText({
      baseUrl: "https://wiki.datacrew.space",
      token: "tok",
      content: "hello",
      collectionId: "col-1",
      sourceGroup: "datacrew",
      title: "A Title",
      metadata: { configuration: { foo: "bar" } },
    });
    const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
    assert.equal(body.collection_id, "col-1");
    assert.equal(body.source_group, "datacrew");
    assert.equal(body.title, "A Title");
    assert.deepEqual(body.metadata, { configuration: { foo: "bar" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingestMdragText returns the failure shape (not a throw) when the enqueue request is non-2xx", async () => {
  const { fn } = fakeFetch([{ status: 500, body: "internal error" }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const result = await ingestMdragText({
      baseUrl: "https://wiki.datacrew.space",
      token: "tok",
      content: "hello",
    });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /mdrag ingest failed: 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingestMdragText returns the failure shape (not a throw) when the enqueue request itself throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  try {
    const result = await ingestMdragText({
      baseUrl: "https://wiki.datacrew.space",
      token: "tok",
      content: "hello",
    });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /mdrag ingest request failed: network down/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingestMdragText hands a successful enqueue off to pollMdragJob, polling the returned status_url", async () => {
  const { fn, calls } = fakeFetch([
    { status: 202, body: { job_id: "job-9", status: "queued", status_url: "/api/v1/jobs/job-9" } },
    { status: 200, body: { status: "finished", result: { documents: [{ document_uid: "doc-9" }] } } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const result = await ingestMdragText({
      baseUrl: "https://wiki.datacrew.space",
      token: "tok",
      content: "hello",
    });
    assert.deepEqual(result, {
      ok: true,
      documentUid: "doc-9",
      result: { documents: [{ document_uid: "doc-9" }] },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://wiki.datacrew.space/api/v1/ingest/text");
    assert.equal(calls[1]?.url, "https://wiki.datacrew.space/api/v1/jobs/job-9");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingestMdragText passes the terminal document id through unchanged, including null", async () => {
  const { fn } = fakeFetch([
    { status: 202, body: { job_id: "job-2", status: "queued", status_url: "/api/v1/jobs/job-2" } },
    { status: 200, body: { status: "finished", result: {} } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const result = await ingestMdragText({
      baseUrl: "https://wiki.datacrew.space",
      token: "tok",
      content: "hello",
    });
    assert.equal(result.ok, true);
    assert.equal((result as { documentUid: string | null }).documentUid, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingestMdragText surfaces a failed job's error without throwing", async () => {
  const { fn } = fakeFetch([
    { status: 202, body: { job_id: "job-3", status: "queued", status_url: "/api/v1/jobs/job-3" } },
    { status: 200, body: { status: "failed", error: "docling parse error" } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const result = await ingestMdragText({
      baseUrl: "https://wiki.datacrew.space",
      token: "tok",
      content: "hello",
    });
    assert.deepEqual(result, { ok: false, error: "docling parse error" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
