import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyProbe,
  decide,
  quotaResetHint,
  readFallback,
  runFallback,
  tierStates,
} from "./lettaQuotaFallback.js";
import type { AgentState, LettaApi, ModelConfig, Quotas } from "./lettaQuotaFallback.js";

const HOUSE: ModelConfig = { model: "gateway/qwen3.8-27b", context_window_limit: 90000, max_tokens: 4096 };
const LETTA: ModelConfig = { model: "letta/auto-chat", context_window_limit: 128000, max_tokens: 8192 };
const EXCLUDE = ["letta-quota-probe", "paperclip-verify"];
const NOW = new Date("2026-10-20T12:00:00Z");
const RESET = "2026-10-21T00:00:00.000Z";
// The text letta-channels relayed to Slack on 2026-09-30.
const QUOTA_BODY =
  "You've used all of your Letta tier model inferences for this day (30,000 per day). Quota resets in 5h 43m. Insufficient credits ($-1.473)";

const EMPTY: Quotas = { lettaTier: { bucket: "empty", dailyBucket: "empty" }, dailyQuotaWindowEnd: RESET };
const FULL: Quotas = { lettaTier: { bucket: "full", dailyBucket: "full" }, dailyQuotaWindowEnd: RESET };

const agent = (id: string, model: string, over: Partial<AgentState> = {}): AgentState => ({
  id,
  name: id,
  model,
  metadata: null,
  contextWindow: LETTA.context_window_limit,
  maxTokens: LETTA.max_tokens,
  ...over,
});
const record = (over: Record<string, unknown> = {}) => ({
  auto_fallback: { previous: LETTA, switched_at: "2026-10-20T01:00:00.000Z", resets_at: RESET, ...over },
});
const run = (a: AgentState, quotas: Quotas, tokens: number | null = 20000, now = NOW) =>
  decide(a, tierStates(quotas), HOUSE, { exclude: EXCLUDE, promptTokens: async () => tokens, now });

test("classifyProbe: quota text is exhausted whatever the status", () => {
  assert.equal(classifyProbe(402, QUOTA_BODY), "exhausted");
  assert.equal(classifyProbe(200, `{"error":"${QUOTA_BODY}"}`), "exhausted");
});

test("classifyProbe: other failures are inconclusive, not exhausted", () => {
  assert.equal(classifyProbe(200, '{"messages":[]}'), "ok");
  assert.equal(classifyProbe(500, "internal error"), "unknown");
});

test("quotaResetHint extracts the reset phrase", () => {
  assert.equal(quotaResetHint(QUOTA_BODY), "Quota resets in 5h 43m");
  assert.equal(quotaResetHint("nothing here"), null);
});

test("decide: exhausted on a Letta model switches and records previous/switched_at/resets_at", async () => {
  const a = agent("emma", LETTA.model, { metadata: { keep: 1 } });
  const act = await run(a, EMPTY);
  assert.equal(act.kind, "switch");
  if (act.kind !== "switch") return;
  assert.deepEqual(act.record, { previous: LETTA, switched_at: NOW.toISOString(), resets_at: RESET });
});

test("decide: exhausted tier with no window end falls back to one hour", async () => {
  const act = await run(agent("emma", LETTA.model), { lettaTier: { bucket: "empty" } });
  assert.equal(act.kind === "switch" && act.record.resets_at, "2026-10-20T13:00:00.000Z");
});

test("decide: quota ok with a record reverts to the recorded model", async () => {
  const act = await run(agent("emma", HOUSE.model, { metadata: record() }), FULL, 20000, new Date("2026-10-21T00:05:00Z"));
  assert.deepEqual(act, { kind: "revert", to: LETTA });
});

test("decide: a record written by the Paperclip adapter is reverted", async () => {
  // Same shape quota-fallback.ts in infra-bonker writes.
  const adapterRecord = {
    auto_fallback: {
      previous: { model: "letta/auto", context_window_limit: 128000, max_tokens: 8192 },
      switched_at: "2026-10-19T20:00:00.000Z",
      resets_at: "2026-10-20T00:00:00.000Z",
    },
  };
  const act = await run(agent("rizz", HOUSE.model, { metadata: adapterRecord }), FULL);
  assert.deepEqual(act, { kind: "revert", to: adapterRecord.auto_fallback.previous });
});

test("decide: a record without resets_at (older watchdog writes) still reverts once quota is back", async () => {
  const act = await run(agent("alix", HOUSE.model, { metadata: record({ resets_at: undefined }) }), FULL);
  assert.equal(act.kind, "revert");
});

test("decide: no revert before resets_at even if the bucket looks full", async () => {
  assert.equal((await run(agent("emma", HOUSE.model, { metadata: record() }), FULL)).kind, "noop");
});

test("decide: no revert while the tier is still empty", async () => {
  const past = new Date("2026-10-21T00:05:00Z");
  assert.equal((await run(agent("emma", HOUSE.model, { metadata: record() }), EMPTY, 1, past)).kind, "noop");
});

test("decide: quota ok without a record (hand switch) is left alone", async () => {
  const act = await run(agent("idris", HOUSE.model), FULL);
  assert.equal(act.kind, "noop");
});

test("decide: exhausted while already on house does nothing", async () => {
  assert.equal((await run(agent("emma", HOUSE.model, { metadata: record() }), EMPTY)).kind, "noop");
  assert.equal((await run(agent("idris", HOUSE.model), EMPTY)).kind, "noop");
});

test("decide: quota ok on a Letta model does nothing", async () => {
  assert.equal((await run(agent("emma", LETTA.model), FULL)).kind, "noop");
});

test("decide: excluded by name or id is never touched, even when exhausted", async () => {
  assert.equal((await run(agent("p1", LETTA.model, { name: "letta-quota-probe" }), EMPTY)).kind, "noop");
  assert.equal((await run(agent("p2", LETTA.model, { name: "paperclip-verify" }), EMPTY)).kind, "noop");
  assert.equal((await run(agent("paperclip-verify", LETTA.model, { name: "x" }), EMPTY)).kind, "noop");
});

test("decide: an excluded agent on the house model with a record is not reverted", async () => {
  const a = agent("p", HOUSE.model, { name: "paperclip-verify", metadata: record() });
  assert.equal((await run(a, FULL, 1, new Date("2026-10-21T00:05:00Z"))).kind, "noop");
});

test("decide: a prompt that cannot fit the house context is skipped, never truncated", async () => {
  const act = await run(agent("big", LETTA.model), EMPTY, 88000);
  assert.equal(act.kind, "skip");
});

test("decide: a prompt that fits with room for the reply switches", async () => {
  assert.equal((await run(agent("alix", LETTA.model), EMPTY, 63000)).kind, "switch");
});

test("decide: unknown prompt size is skipped rather than guessed", async () => {
  assert.equal((await run(agent("x", LETTA.model), EMPTY, null)).kind, "skip");
});

test("decide: per-inference handles draw on credits, not the tier, and are left alone", async () => {
  for (const m of ["openai/gpt-5", "anthropic/claude-sonnet-5-5"]) {
    assert.equal((await run(agent("job-scorer", m), EMPTY)).kind, "noop");
  }
});

test("decide: an incomplete previous-model config is not switched", async () => {
  const act = await run(agent("x", LETTA.model, { contextWindow: undefined }), EMPTY);
  assert.equal(act.kind, "skip");
});

test("decide: an incomplete record does nothing rather than guess", async () => {
  const partial = { auto_fallback: { previous: { model: "letta/auto-chat" } } };
  assert.equal((await run(agent("x", HOUSE.model, { metadata: partial }), FULL)).kind, "noop");
  assert.equal(readFallback(partial), null);
});

test("decide: unknown quota state never switches or reverts", async () => {
  const unknown: Quotas = { agents: 6 };
  assert.equal((await run(agent("a", LETTA.model), unknown)).kind, "noop");
  assert.equal((await run(agent("b", HOUSE.model, { metadata: record() }), unknown, 1, new Date("2027-01-01"))).kind, "noop");
});

function fakeApi(agents: AgentState[], over: Partial<LettaApi> = {}) {
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const api: LettaApi = {
    listAgents: async () => agents,
    getQuotas: async () => EMPTY,
    probe: async () => "unknown",
    promptTokens: async () => 20000,
    patchAgent: async (id, body) => {
      patches.push({ id, body });
    },
    ...over,
  };
  return { api, patches };
}
const deps = { house: HOUSE, exclude: EXCLUDE, now: NOW, log: () => {} };

test("runFallback: one agent's failed PATCH does not stop the others", async () => {
  const { api, patches } = fakeApi([agent("a", LETTA.model), agent("b", LETTA.model), agent("c", LETTA.model)], {
    patchAgent: async (id, body) => {
      if (id === "b") throw new Error("Letta PATCH failed: 500");
      patches.push({ id, body });
    },
  });
  const out = await runFallback(api, deps);
  assert.deepEqual(out.map((s) => [s.agent, s.action]), [["a", "switch"], ["b", "error"], ["c", "switch"]]);
  assert.match(out[1].reason, /500/);
  assert.deepEqual(patches.map((p) => p.id), ["a", "c"]);
});

test("runFallback: the switch PATCH carries house config and merges the record into existing metadata", async () => {
  const { api, patches } = fakeApi([agent("a", LETTA.model, { metadata: { owner: "emma" } })]);
  await runFallback(api, deps);
  assert.deepEqual(patches[0].body, {
    ...HOUSE,
    metadata: { owner: "emma", auto_fallback: { previous: LETTA, switched_at: NOW.toISOString(), resets_at: RESET } },
  });
});

test("runFallback: the revert PATCH restores the model and drops only the record", async () => {
  const later = new Date("2026-10-21T00:05:00Z");
  const { api, patches } = fakeApi([agent("a", HOUSE.model, { metadata: { owner: "emma", ...record() } })], {
    getQuotas: async () => FULL,
  });
  const out = await runFallback(api, { ...deps, now: later });
  assert.equal(out[0].action, "revert");
  assert.deepEqual(patches[0].body, { ...LETTA, metadata: { owner: "emma" } });
});

test("runFallback: a failing quotas call falls back to the ping probe", async () => {
  const { api, patches } = fakeApi([agent("a", LETTA.model)], {
    getQuotas: async () => {
      throw new Error("quotas 503");
    },
    probe: async () => "exhausted",
  });
  const out = await runFallback(api, deps);
  assert.equal(out[0].action, "switch");
  assert.equal(patches.length, 1);
});

test("runFallback: quotas and ping both failing changes nothing", async () => {
  const { api, patches } = fakeApi([agent("a", LETTA.model)], {
    getQuotas: async () => {
      throw new Error("quotas 503");
    },
    probe: async () => "unknown",
  });
  const out = await runFallback(api, deps);
  assert.equal(out[0].action, "noop");
  assert.equal(patches.length, 0);
});

test("runFallback: a prompt-size lookup failure skips that agent only", async () => {
  const { api } = fakeApi([agent("a", LETTA.model), agent("b", LETTA.model)], {
    promptTokens: async (id) => {
      if (id === "a") throw new Error("context 500");
      return 1000;
    },
  });
  const out = await runFallback(api, deps);
  assert.deepEqual(out.map((s) => s.action), ["error", "switch"]);
});
