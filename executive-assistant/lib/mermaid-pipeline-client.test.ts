import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  MermaidPipelineAuthError,
  MermaidPipelineConfigError,
  MermaidPipelineHttpError,
  MermaidPipelineTurnInFlightError,
  MermaidPipelineUpstreamError,
  mermaidPipelineConfigFromEnv,
  runPipelineTurn,
} from "./mermaid-pipeline-client.js";

type Seen = { method?: string; url?: string; auth?: string; body: Record<string, unknown> };

/** A fake mermaid-api: records the request, replies with `status` + `json`. */
async function withApi<T>(
  status: number,
  json: unknown,
  run: (url: string, seen: Seen[]) => Promise<T>
): Promise<T> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.close();
  }
}

test("posts {run_id, text} to /v1/pipeline/turn with the bearer and returns reply", async () => {
  await withApi(200, { reply: "graph TD; A-->B" }, async (url, seen) => {
    const reply = await runPipelineTurn({ runId: "run_1", text: "hello" }, { url: `${url}/`, token: "t0k" });
    assert.equal(reply, "graph TD; A-->B");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.url, "/v1/pipeline/turn");
    assert.equal(seen[0]!.auth, "Bearer t0k");
    assert.deepEqual(seen[0]!.body, { run_id: "run_1", text: "hello" });
    assert.equal("mode" in seen[0]!.body, false, "no mode field");
  });
});

test("409 maps to MermaidPipelineTurnInFlightError", async () => {
  await withApi(409, { error: "turn in flight" }, async (url) => {
    await assert.rejects(
      () => runPipelineTurn({ runId: "r", text: "t" }, { url, token: "t" }),
      (e: unknown) => e instanceof MermaidPipelineTurnInFlightError && /r/.test((e as Error).message)
    );
  });
});

test("401 and 403 map to MermaidPipelineAuthError", async () => {
  for (const status of [401, 403]) {
    await withApi(status, { error: "nope" }, async (url) => {
      await assert.rejects(() => runPipelineTurn({ runId: "r", text: "t" }, { url, token: "t" }), MermaidPipelineAuthError);
    });
  }
});

test("502 maps to MermaidPipelineUpstreamError carrying the bridge message", async () => {
  await withApi(502, { error: "turn went idle" }, async (url) => {
    await assert.rejects(
      () => runPipelineTurn({ runId: "r", text: "t" }, { url, token: "t" }),
      (e: unknown) => e instanceof MermaidPipelineUpstreamError && /turn went idle/.test((e as Error).message)
    );
  });
});

test("any other non-2xx maps to MermaidPipelineHttpError with its status", async () => {
  await withApi(500, "boom", async (url) => {
    await assert.rejects(
      () => runPipelineTurn({ runId: "r", text: "t" }, { url, token: "t" }),
      (e: unknown) => e instanceof MermaidPipelineHttpError && (e as MermaidPipelineHttpError).status === 500
    );
  });
});

test("a 200 without a string reply is an error, not an empty string", async () => {
  await withApi(200, { nope: 1 }, async (url) => {
    await assert.rejects(() => runPipelineTurn({ runId: "r", text: "t" }, { url, token: "t" }), MermaidPipelineHttpError);
  });
});

test("an empty run id is refused before any request", async () => {
  await assert.rejects(() => runPipelineTurn({ runId: "", text: "t" }, { url: "http://127.0.0.1:1", token: "t" }), /run id/i);
});

test("config: default URL is http://mermaid-api:8000, token comes from MERMAID_PIPELINE_TOKEN", () => {
  const cfg = mermaidPipelineConfigFromEnv({ MERMAID_PIPELINE_TOKEN: "tok" } as NodeJS.ProcessEnv);
  assert.deepEqual({ url: cfg.url, token: cfg.token }, { url: "http://mermaid-api:8000", token: "tok" });
  const over = mermaidPipelineConfigFromEnv({ MERMAID_PIPELINE_TOKEN: "tok", MERMAID_API_URL: "http://x:1" } as NodeJS.ProcessEnv);
  assert.equal(over.url, "http://x:1");
});

test("config: missing token is a MermaidPipelineConfigError; the old bridge token is ignored", () => {
  assert.throws(() => mermaidPipelineConfigFromEnv({} as NodeJS.ProcessEnv), MermaidPipelineConfigError);
  assert.throws(
    () => mermaidPipelineConfigFromEnv({ LETTA_CHANNEL_BRIDGE_TOKEN: "old" } as NodeJS.ProcessEnv),
    MermaidPipelineConfigError
  );
});
