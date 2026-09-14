import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRunStatusRequest,
  buildTriggerRequest,
  secretKeyName,
} from "./trigger-task.js";

describe("secretKeyName", () => {
  it("upper-snake-cases a project key name", () => {
    assert.equal(secretKeyName("watchdog"), "WATCHDOG_TRIGGER_SECRET_KEY");
  });

  it("replaces non-alphanumeric characters with underscores", () => {
    assert.equal(secretKeyName("indb-blues"), "INDB_BLUES_TRIGGER_SECRET_KEY");
  });
});

describe("buildTriggerRequest", () => {
  it("builds a POST with the bearer key, idempotency header, and JSON body", () => {
    const req = buildTriggerRequest(
      "tr_prod_abc",
      "hello-observability",
      { message: "hi" },
      "my-stable-key-001",
      undefined,
      "https://triggers.datacrew.space"
    );

    assert.equal(req.method, "POST");
    assert.equal(req.url, "https://triggers.datacrew.space/api/v1/tasks/hello-observability/trigger");
    assert.equal(req.headers["Authorization"], "Bearer tr_prod_abc");
    assert.equal(req.headers["idempotency-key"], "my-stable-key-001");
    assert.deepEqual(JSON.parse(req.body ?? "{}"), { payload: { message: "hi" } });
  });

  it("URL-encodes the task id", () => {
    const req = buildTriggerRequest("k", "a/b c", {}, "idem", undefined, "https://x.example");
    assert.equal(req.url, "https://x.example/api/v1/tasks/a%2Fb%20c/trigger");
  });

  it("strips a trailing slash from a passed baseUrl", () => {
    const req = buildTriggerRequest("k", "t", {}, "idem", undefined, "https://x.example/");
    assert.equal(req.url, "https://x.example/api/v1/tasks/t/trigger");
  });

  it("passes options through into the body untouched", () => {
    const req = buildTriggerRequest("k", "t", {}, "idem", { tags: ["from-script"] }, "https://x.example");
    assert.deepEqual(JSON.parse(req.body ?? "{}").options, { tags: ["from-script"] });
  });
});

describe("buildRunStatusRequest", () => {
  it("builds a GET with the bearer key and no body", () => {
    const req = buildRunStatusRequest("tr_prod_abc", "run_123", "https://triggers.datacrew.space");
    assert.equal(req.method, "GET");
    assert.equal(req.url, "https://triggers.datacrew.space/api/v3/runs/run_123");
    assert.equal(req.headers["Authorization"], "Bearer tr_prod_abc");
    assert.equal(req.body, undefined);
  });

  it("URL-encodes the run id", () => {
    const req = buildRunStatusRequest("k", "run/1", "https://x.example");
    assert.equal(req.url, "https://x.example/api/v3/runs/run%2F1");
  });
});
