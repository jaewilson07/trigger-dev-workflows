import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { classifyGraphType } from "./mermaid-classify.js";
import { distillTranscript } from "./mermaid-distill.js";
import { completeText } from "./mermaid-llm.js";
import { renderStateless, renderViaConversation } from "./mermaid-render.js";

type Seen = { auth?: string; body: Record<string, unknown> };

/** Fake mermaid-api answering every pipeline turn with `reply`. */
async function withApi<T>(reply: string, run: (url: string, seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.close();
  }
}

/** Point the env-configured client at a fake for the duration of `fn`. */
async function withEnv<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const saved = { u: process.env.MERMAID_API_URL, t: process.env.MERMAID_PIPELINE_TOKEN };
  process.env.MERMAID_API_URL = url;
  process.env.MERMAID_PIPELINE_TOKEN = "svc-token";
  try {
    return await fn();
  } finally {
    if (saved.u === undefined) delete process.env.MERMAID_API_URL;
    else process.env.MERMAID_API_URL = saved.u;
    if (saved.t === undefined) delete process.env.MERMAID_PIPELINE_TOKEN;
    else process.env.MERMAID_PIPELINE_TOKEN = saved.t;
  }
}

test("completeText folds system+user into one turn keyed by the run id", async () => {
  await withApi("graph TD; A-->B", async (url, seen) => {
    const text = await completeText("sys", "usr", { runId: "run_abc", client: { url, token: "t0k" } });
    assert.equal(text, "graph TD; A-->B");
    assert.equal(seen[0]!.auth, "Bearer t0k");
    assert.deepEqual(seen[0]!.body, { run_id: "run_abc", text: "sys\n\nusr" });
  });
});

test("classify, distill and render of one run all use that run's id", async () => {
  await withApi('```mermaid\nflowchart TD\nA-->B\n```', async (url, seen) => {
    await withEnv(url, async () => {
      await classifyGraphType("a then b", "run_same");
      await distillTranscript("flowchart", "a then b", "run_same").catch(() => undefined);
      await renderStateless("flowchart", { type: "flowchart", steps: [] } as never, "run_same");
    });
    assert.ok(seen.length >= 3, `expected at least 3 turns, saw ${seen.length}`);
    assert.deepEqual([...new Set(seen.map((s) => s.body.run_id))], ["run_same"]);
    assert.equal(seen.every((s) => s.auth === "Bearer svc-token"), true);
    assert.equal(seen.every((s) => !("mode" in s.body)), true);
  });
});

test("two runs use two different keys", async () => {
  await withApi("{}", async (url, seen) => {
    await withEnv(url, async () => {
      await classifyGraphType("x", "run_1");
      await classifyGraphType("x", "run_2");
    });
    assert.deepEqual(seen.map((s) => s.body.run_id), ["run_1", "run_2"]);
  });
});

test("render escalation goes through the pipeline client with the run id", async () => {
  await withApi("```mermaid\nflowchart TD\nA-->B\n```", async (url, seen) => {
    const diagram = await withEnv(url, () =>
      renderViaConversation("run_esc", "flowchart", { type: "flowchart", steps: [] } as never, "Parse error line 2")
    );
    assert.equal(diagram, "flowchart TD\nA-->B");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.body.run_id, "run_esc");
    assert.match(String(seen[0]!.body.text), /Parse error line 2/);
  });
});

test("render escalation with no fenced block throws", async () => {
  await withApi("sorry, no", async (url) => {
    await withEnv(url, async () => {
      await assert.rejects(
        () => renderViaConversation("r", "flowchart", { type: "flowchart", steps: [] } as never, "e"),
        /no fenced Mermaid block/
      );
    });
  });
});

test("missing token fails loudly instead of reaching for another LLM path", async () => {
  const saved = process.env.MERMAID_PIPELINE_TOKEN;
  delete process.env.MERMAID_PIPELINE_TOKEN;
  try {
    await assert.rejects(() => completeText("s", "u", { runId: "r" }), /MERMAID_PIPELINE_TOKEN/);
  } finally {
    if (saved !== undefined) process.env.MERMAID_PIPELINE_TOKEN = saved;
  }
});
