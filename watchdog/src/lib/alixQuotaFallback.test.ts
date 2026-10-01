import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProbe, decide, FALLBACK_TAG, quotaResetHint } from "./alixQuotaFallback.js";
import type { AgentState, ModelConfig } from "./alixQuotaFallback.js";

const HOUSE: ModelConfig = { model: "gateway/qwen3.8-27b", context_window_limit: 90000, max_tokens: 4096 };
const LETTA: ModelConfig = { model: "letta/auto-chat", context_window_limit: 128000, max_tokens: 8192 };
// The text letta-channels relayed to Slack on 2026-09-30.
const QUOTA_BODY =
  "You've used all of your Letta tier model inferences for this day (30,000 per day). Quota resets in 5h 43m. Insufficient credits ($-1.473)";

const agent = (model: string, tags: string[] = [], metadata: AgentState["metadata"] = null): AgentState => ({
  model,
  tags,
  metadata,
});

test("classifyProbe: quota text is exhausted whatever the status", () => {
  assert.equal(classifyProbe(402, QUOTA_BODY), "exhausted");
  assert.equal(classifyProbe(429, QUOTA_BODY), "exhausted");
  assert.equal(classifyProbe(200, `{"error":"${QUOTA_BODY}"}`), "exhausted");
});

test("classifyProbe: other failures are inconclusive, not exhausted", () => {
  assert.equal(classifyProbe(200, '{"messages":[]}'), "ok");
  assert.equal(classifyProbe(500, "internal error"), "unknown");
  assert.equal(classifyProbe(502, ""), "unknown");
});

test("decide: exhausted on a Letta model switches to house", () => {
  assert.deepEqual(decide("exhausted", agent(LETTA.model), HOUSE), { kind: "switch-to-house" });
});

test("decide: exhausted while already on house does nothing", () => {
  assert.equal(decide("exhausted", agent(HOUSE.model, [FALLBACK_TAG]), HOUSE).kind, "noop");
});

test("decide: quota back reverts a managed switch to the recorded model", () => {
  const a = agent(HOUSE.model, [FALLBACK_TAG], { auto_fallback: { previous: LETTA } });
  assert.deepEqual(decide("ok", a, HOUSE), { kind: "revert", to: LETTA });
});

test("decide: a hand-made house switch is never reverted", () => {
  assert.equal(decide("ok", agent(HOUSE.model), HOUSE).kind, "noop");
});

test("decide: managed without a recorded model does nothing rather than guess", () => {
  assert.equal(decide("ok", agent(HOUSE.model, [FALLBACK_TAG], {}), HOUSE).kind, "noop");
});

test("decide: an inconclusive probe never switches", () => {
  assert.equal(decide("unknown", agent(LETTA.model), HOUSE).kind, "noop");
  assert.equal(decide("unknown", agent(HOUSE.model, [FALLBACK_TAG], { auto_fallback: { previous: LETTA } }), HOUSE).kind, "noop");
});

test("quotaResetHint extracts the reset phrase", () => {
  assert.equal(quotaResetHint(QUOTA_BODY), "Quota resets in 5h 43m");
  assert.equal(quotaResetHint("nothing here"), null);
});
