import assert from "node:assert/strict";
import { test } from "node:test";
import { describeOrchestratorFailure, parseOrchestratorResult } from "./orchestratorResult.js";

test("parses main.py's pretty-printed (indent=2) JSON stdout, not just its last line", () => {
  // Reproduces the exact shape confirmed live against main.py --dry-run:
  // json.dumps(result, indent=2) spans multiple lines, and its own last line
  // is a lone "}" — the bug slack-community-journal run
  // run_cmul9a4fg01cc4hl839sntvu8 hit (SyntaxError: Unexpected token '}').
  const stdout = '{\n  "status": "dry-run",\n  "window": {\n    "days": 7\n  },\n  "item_count": 0\n}\n';
  const parsed = parseOrchestratorResult(stdout);
  assert.equal(parsed.status, "dry-run");
  assert.equal(parsed.item_count, 0);
});

test("the old .split('\\n').pop() approach would have failed on that same stdout", () => {
  const stdout = '{\n  "status": "dry-run",\n  "window": {\n    "days": 7\n  },\n  "item_count": 0\n}\n';
  const lastLine = stdout.trim().split("\n").pop() ?? "{}";
  assert.equal(lastLine, "}");
  assert.throws(() => JSON.parse(lastLine), SyntaxError);
});

test("parses single-line JSON stdout too", () => {
  const parsed = parseOrchestratorResult('{"status":"emitted","item_count":3}\n');
  assert.equal(parsed.status, "emitted");
  assert.equal(parsed.item_count, 3);
});

test("returns the fallback for empty stdout instead of throwing", () => {
  assert.deepEqual(parseOrchestratorResult("   \n"), {});
  assert.deepEqual(parseOrchestratorResult("", { status: "no-posts" }), { status: "no-posts" });
});

test("throws a diagnosable error (not a bare SyntaxError) when stdout truly isn't JSON", () => {
  assert.throws(() => parseOrchestratorResult("not json at all"), /orchestrator stdout was not valid JSON/);
});

test("leads the failure message with the final stderr line, not the head", () => {
  // Reproduces the domo-community-journal run's real shape (5 chatty INFO
  // lines, then the actual traceback/exception at the very end) — Trigger.dev
  // truncates from the head, so the old head-first message never showed the
  // real failure.
  const stderr = [
    '[domo-community-journal] INFO HTTP Request: GET https://community-forums.domo.com/api/v2/categories?limit=200 "HTTP/1.1 200 OK"',
    '[domo-community-journal] INFO HTTP Request: GET https://community-forums.domo.com/api/v2/discussions?page=1 "HTTP/1.1 200 OK"',
    "[domo-community-journal] INFO fetched 9 unique posts over the trailing 7 days",
    '[domo-community-journal] INFO HTTP Request: POST http://letta-shim:8400/v1/chat/completions "HTTP/1.1 502 Bad Gateway"',
    "Traceback (most recent call last):",
    '  File "main.py", line 273, in synthesize',
    "    resp.raise_for_status()",
    "llm_client.LlmError: letta gateway call failed: Server error '502 Bad Gateway' for url 'http://letta-shim:8400/v1/chat/completions'",
  ].join("\n");
  const error = Object.assign(new Error(`Command failed: uv run ...\n${stderr}`), { stderr, stdout: "" });

  const described = describeOrchestratorFailure("domo-community-journal", error);
  const firstLine = described.split("\n")[0];

  assert.match(firstLine, /^domo-community-journal failed: llm_client\.LlmError: letta gateway call failed/);
  assert.match(described, /stderr tail/);
  // The chatty head is still present (for context) but not first.
  assert.ok(described.includes("fetched 9 unique posts"));
});

test("caps the stderr tail instead of reproducing unbounded stderr", () => {
  const stderr = `first line\n${"x".repeat(10_000)}\nllm_client.LlmError: boom`;
  const error = Object.assign(new Error("Command failed"), { stderr });
  const described = describeOrchestratorFailure("slack-community-journal", error);
  assert.ok(described.length < stderr.length + 200);
});

test("falls back to the raw error message when there is no captured stderr", () => {
  const described = describeOrchestratorFailure("slack-community-journal", new Error("ENOENT: uv not found"));
  assert.equal(described, "slack-community-journal failed: ENOENT: uv not found");
});

test("handles a non-Error thrown value", () => {
  const described = describeOrchestratorFailure("slack-community-journal", "weird string throw");
  assert.equal(described, "slack-community-journal failed: weird string throw");
});
