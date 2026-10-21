import test from "node:test";
import assert from "node:assert/strict";
import { decideTransitions } from "./endpointTransitionCore.js";
import type { EndpointResult } from "./infra-health.js";

const r = (status: EndpointResult["status"], name = "livekit"): EndpointResult => ({
  name, url: "http://x", status, httpStatus: status === "unknown" ? null : 200, note: "n", advisories: [],
});

test("first healthy run is silent", () => {
  assert.deepEqual(decideTransitions(null, [r("ok")]).messages, []);
});
test("first failing run alerts once", () => {
  assert.equal(decideTransitions(null, [r("unknown")]).messages.length, 1);
});
test("a still-down endpoint does not repeat", () => {
  const first = decideTransitions({ livekit: "up" }, [r("degraded")]);
  assert.equal(first.messages.length, 1);
  assert.deepEqual(decideTransitions(first.state, [r("degraded")]).messages, []);
  assert.deepEqual(decideTransitions(first.state, [r("unknown")]).messages, []);
});
test("recovery fires exactly once", () => {
  const d = decideTransitions({ livekit: "down" }, [r("ok")]);
  assert.equal(d.messages.length, 1);
  assert.match(d.messages[0]!, /healthy again/);
  assert.deepEqual(decideTransitions(d.state, [r("ok")]).messages, []);
});
