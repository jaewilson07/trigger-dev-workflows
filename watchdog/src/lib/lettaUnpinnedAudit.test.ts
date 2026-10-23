import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PaperclipAgentsError,
  PaperclipAgentsShapeError,
  REMIND_AFTER_MS,
  fetchPaperclipAgents,
  findUnpinned,
  runAudit,
} from "./lettaUnpinnedAudit.js";
import type { AuditOutput, PaperclipAgent } from "./lettaUnpinnedAudit.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const letta = (id: string, conversationId?: unknown, over: Partial<PaperclipAgent> = {}): PaperclipAgent => ({
  id,
  name: `agent-${id}`,
  status: "idle",
  adapterType: "letta_cloud",
  adapterConfig: conversationId === undefined ? { agentId: "a" } : { agentId: "a", conversationId },
  ...over,
});
const prev = (ids: string[], lastAlertedAt: string | null): AuditOutput => ({
  unpinnedIds: ids,
  findings: [],
  lastAlertedAt,
  checked: ids.length,
  alerted: true,
});

function harness(agents: PaperclipAgent[], previous: AuditOutput | null = null) {
  const sent: string[] = [];
  return {
    sent,
    deps: {
      fetchAgents: async () => agents,
      notify: async (t: string) => void sent.push(t),
      previous: async () => previous,
      now: NOW,
    },
  };
}

test("findUnpinned: flags letta_cloud agents with a missing or blank conversationId", () => {
  const found = findUnpinned([letta("b"), letta("a", ""), letta("c", "  "), letta("d", 42)]);
  assert.deepEqual(found.map((f) => f.id), ["a", "b", "c", "d"]);
});

test("findUnpinned: ignores pinned, non-letta and terminated agents; tolerates null adapterConfig", () => {
  const found = findUnpinned([
    letta("pinned", "conv-1"),
    letta("claude", undefined, { adapterType: "claude_local" }),
    letta("gone", undefined, { status: "terminated" }),
    letta("nullcfg", undefined, { adapterConfig: null }),
  ]);
  assert.deepEqual(found.map((f) => f.id), ["nullcfg"]);
});

test("runAudit: all agents pinned -> no alert", async () => {
  const h = harness([letta("a", "c1"), letta("b", "c2")]);
  const out = await runAudit(h.deps);
  assert.equal(h.sent.length, 0);
  assert.equal(out.alerted, false);
  assert.deepEqual(out.unpinnedIds, []);
  assert.equal(out.checked, 2);
});

test("runAudit: unpinned agent alerts with name and id", async () => {
  const h = harness([letta("a", "c1"), letta("b")]);
  const out = await runAudit(h.deps);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /agent-b \(b,/);
  assert.equal(out.lastAlertedAt, NOW.toISOString());
});

test("runAudit: same set within the reminder window does not re-alert, and keeps lastAlertedAt", async () => {
  const lastAlertedAt = new Date(NOW.getTime() - 60_000).toISOString();
  const h = harness([letta("b")], prev(["b"], lastAlertedAt));
  const out = await runAudit(h.deps);
  assert.equal(h.sent.length, 0);
  assert.equal(out.lastAlertedAt, lastAlertedAt);
});

test("runAudit: same set after the reminder window re-alerts", async () => {
  const lastAlertedAt = new Date(NOW.getTime() - REMIND_AFTER_MS - 1).toISOString();
  const h = harness([letta("b")], prev(["b"], lastAlertedAt));
  await runAudit(h.deps);
  assert.equal(h.sent.length, 1);
});

test("runAudit: a changed set re-alerts immediately", async () => {
  const lastAlertedAt = new Date(NOW.getTime() - 60_000).toISOString();
  const h = harness([letta("b"), letta("c")], prev(["b"], lastAlertedAt));
  await runAudit(h.deps);
  assert.equal(h.sent.length, 1);
});

test("runAudit: fetch failure propagates and nothing is sent", async () => {
  const sent: string[] = [];
  await assert.rejects(
    runAudit({
      fetchAgents: async () => {
        throw new PaperclipAgentsError("boom", 500);
      },
      notify: async (t) => void sent.push(t),
      previous: async () => null,
      now: NOW,
    }),
    PaperclipAgentsError,
  );
  assert.equal(sent.length, 0);
});

test("fetchPaperclipAgents: non-2xx throws PaperclipAgentsError with the numeric status", async () => {
  const fake = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  await assert.rejects(fetchPaperclipAgents("k", fake), (e: unknown) => e instanceof PaperclipAgentsError && e.status === 401);
});

test("fetchPaperclipAgents: non-array body throws a shape error", async () => {
  const fake = (async () => new Response('{"error":"x"}', { status: 200 })) as typeof fetch;
  await assert.rejects(fetchPaperclipAgents("k", fake), PaperclipAgentsShapeError);
});

test("fetchPaperclipAgents: sends bearer, user agent and a timeout signal, and returns the array", async () => {
  let seen: RequestInit | undefined;
  let url = "";
  const fake = (async (u: string, init?: RequestInit) => {
    url = u;
    seen = init;
    return new Response(JSON.stringify([letta("a", "c")]), { status: 200 });
  }) as unknown as typeof fetch;
  const agents = await fetchPaperclipAgents("secret-key", fake);
  assert.equal(agents.length, 1);
  assert.match(url, /\/companies\/9da83648-583b-4f62-9049-888eae6ad8ae\/agents$/);
  const headers = seen?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer secret-key");
  assert.equal(headers["User-Agent"], "datacrew-claude-code/1.0");
  assert.ok(seen?.signal);
  assert.equal(seen?.method, undefined);
});
