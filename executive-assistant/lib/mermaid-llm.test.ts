import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { completeViaLettaChannel, parseSseBlock } from "./letta-channel.js";
import { completeText } from "./mermaid-llm.js";

type Seen = { auth?: string; body: Record<string, unknown> };

/** A fake wiki-stream bridge: records the request, replies with `frames`. */
async function withBridge<T>(
  frames: string,
  status: number,
  run: (url: string, seen: Seen[]) => Promise<T>
): Promise<T> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "text/plain" });
      res.end(frames);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.close();
  }
}

const OK = ': open\n\nevent: thinking\ndata: {"tool":"x"}\n\nevent: keepalive\ndata: {}\n\nevent: done\ndata: {"text":"graph TD; A-->B"}\n\n';

test("completeText sends one channel turn (system+user folded) and returns the done text", async () => {
  await withBridge(OK, 200, async (url, seen) => {
    const text = await completeText("sys", "usr", { channel: { url, token: "t0k" } });
    assert.equal(text, "graph TD; A-->B");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, "Bearer t0k");
    assert.equal(seen[0].body.text, "sys\n\nusr");
    assert.equal(seen[0].body.mode, "mermaid");
    assert.match(String(seen[0].body.conversationId), /^mermaid:/);
    assert.equal("email" in seen[0].body, false, "no identity is invented");
  });
});

test("completeText forwards a real email and a caller-chosen conversation key", async () => {
  await withBridge(OK, 200, async (url, seen) => {
    await completeText("s", "u", { channel: { url, token: "t" }, userEmail: "a@b.co", conversationKey: "mermaid:sess1" });
    assert.equal(seen[0].body.email, "a@b.co");
    assert.equal(seen[0].body.conversationId, "mermaid:sess1");
  });
});

test("an error frame is thrown, not swallowed", async () => {
  await withBridge('event: error\ndata: {"message":"turn went idle"}\n\n', 200, async (url) => {
    await assert.rejects(() => completeText("s", "u", { channel: { url, token: "t" } }), /turn went idle/);
  });
});

test("a stream that closes without done is an error", async () => {
  await withBridge(": open\n\nevent: keepalive\ndata: {}\n\n", 200, async (url) => {
    await assert.rejects(() => completeText("s", "u", { channel: { url, token: "t" } }), /without a done frame/);
  });
});

test("a non-2xx (e.g. 409 turn in flight, 401) is thrown with its status", async () => {
  await withBridge('{"error":"a turn is already in flight"}', 409, async (url) => {
    await assert.rejects(() => completeViaLettaChannel({ conversationKey: "k", text: "t" }, { url, token: "t" }), /409/);
  });
});

test("missing env config fails loudly instead of reaching for another LLM path", async () => {
  const saved = { u: process.env.MERMAID_LETTA_CHANNEL_URL, t: process.env.LETTA_CHANNEL_BRIDGE_TOKEN };
  delete process.env.MERMAID_LETTA_CHANNEL_URL;
  delete process.env.LETTA_CHANNEL_BRIDGE_TOKEN;
  try {
    await assert.rejects(() => completeText("s", "u"), /MERMAID_LETTA_CHANNEL_URL is not set/);
  } finally {
    if (saved.u !== undefined) process.env.MERMAID_LETTA_CHANNEL_URL = saved.u;
    if (saved.t !== undefined) process.env.LETTA_CHANNEL_BRIDGE_TOKEN = saved.t;
  }
});

test("parseSseBlock ignores comments and reads event + data", () => {
  assert.deepEqual(parseSseBlock(': open\nevent: done\ndata: {"text":"x"}'), { event: "done", data: { text: "x" } });
  assert.equal(parseSseBlock(": open"), null);
});
