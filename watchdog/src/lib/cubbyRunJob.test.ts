import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  CubbyConfigError,
  CubbyConnectTimeoutError,
  CubbyJobFailedError,
  CubbyJobRejectedError,
  hostKeyMatches,
  runCubbyJob,
  type SshExecRequest,
  type SshTransport,
} from "./cubbyRunJob.js";

const ENV = { CUBBY_RUN_JOB_SSH_KEY: "-----BEGIN FAKE-----\nabc\n-----END FAKE-----", CUBBY_SSH_HOST_KEY: "ssh-ed25519 AAAA" };

function fake(result: { exitCode: number; output: string } | { code: string } | Error) {
  const calls: SshExecRequest[] = [];
  const transport: SshTransport = async (req) => {
    calls.push(req);
    if (result instanceof Error) throw result;
    if ("code" in result) throw Object.assign(new Error(result.code), { code: result.code });
    return result;
  };
  return { transport, calls };
}

test("success: exit 0 returns ok with output tail and sends only the job name", async () => {
  const { transport, calls } = fake({ exitCode: 0, output: "done\n" });
  const r = await runCubbyJob("sync-docs-to-kb", { transport, env: ENV });
  assert.deepEqual(r, { status: "ok", job: "sync-docs-to-kb", exitCode: 0, outputTail: "done" });
  assert.equal(calls[0]?.command, "sync-docs-to-kb");
  assert.equal(calls[0]?.host, "cubby.lan");
  assert.equal(calls[0]?.connectTimeoutMs, 15_000);
});

test("job failure: non-zero throws CubbyJobFailedError with exit code and last 50 lines", async () => {
  const output = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
  const { transport } = fake({ exitCode: 7, output });
  await assert.rejects(runCubbyJob("improve-system", { transport, env: ENV }), (e: unknown) => {
    assert.ok(e instanceof CubbyJobFailedError);
    assert.equal(e.name, "CubbyJobFailedError");
    assert.equal(e.exitCode, 7);
    const lines = e.outputTail.split("\n");
    assert.equal(lines.length, 50);
    assert.equal(lines[0], "line 31");
    assert.equal(lines[49], "line 80");
    return true;
  });
});

test("rejected name: exit 2 throws CubbyJobRejectedError, not the generic failure", async () => {
  const { transport } = fake({ exitCode: 2, output: "unknown job" });
  await assert.rejects(runCubbyJob("nope", { transport, env: ENV }), (e: unknown) => {
    assert.ok(e instanceof CubbyJobRejectedError);
    assert.ok(!(e instanceof CubbyJobFailedError));
    return true;
  });
});

for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]) {
  test(`offline: ${code} returns skipped without throwing`, async () => {
    const { transport } = fake({ code });
    const r = await runCubbyJob("update-letta-code", { transport, env: ENV });
    assert.deepEqual(r, { status: "skipped", job: "update-letta-code", reason: "cubby offline" });
  });
}

test("offline: connect timeout returns skipped", async () => {
  const { transport } = fake(new CubbyConnectTimeoutError("t"));
  const r = await runCubbyJob("update-letta-code", { transport, env: ENV });
  assert.equal(r.status, "skipped");
});

test("non-network transport error (e.g. auth failure) still throws", async () => {
  const { transport } = fake(new Error("All configured authentication methods failed"));
  await assert.rejects(runCubbyJob("improve-system", { transport, env: ENV }), /authentication/);
});

test("missing private key throws CubbyConfigError and never connects", async () => {
  const { transport, calls } = fake({ exitCode: 0, output: "" });
  await assert.rejects(
    runCubbyJob("improve-system", { transport, env: { CUBBY_SSH_HOST_KEY: "x y" } }),
    (e: unknown) => e instanceof CubbyConfigError && /CUBBY_RUN_JOB_SSH_KEY/.test((e as Error).message),
  );
  assert.equal(calls.length, 0);
});

test("missing host key throws CubbyConfigError and never connects", async () => {
  const { transport, calls } = fake({ exitCode: 0, output: "" });
  await assert.rejects(
    runCubbyJob("improve-system", { transport, env: { CUBBY_RUN_JOB_SSH_KEY: "k", CUBBY_SSH_HOST_KEY: "  " } }),
    (e: unknown) => e instanceof CubbyConfigError && /CUBBY_SSH_HOST_KEY/.test((e as Error).message),
  );
  assert.equal(calls.length, 0);
});

test("the private key never appears in an error message", async () => {
  const { transport } = fake({ exitCode: 1, output: "boom" });
  await assert.rejects(runCubbyJob("improve-system", { transport, env: ENV }), (e: unknown) => {
    assert.ok(!(e as Error).message.includes("BEGIN FAKE"));
    return true;
  });
});

test("hostKeyMatches: key line and SHA256 fingerprint match; wrong key and junk do not", () => {
  const key = Buffer.from("server-host-key-blob");
  const other = Buffer.from("different-key");
  const line = `ssh-ed25519 ${key.toString("base64")} root@cubby`;
  const fp = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
  assert.ok(hostKeyMatches(line, key));
  assert.ok(hostKeyMatches(fp, key));
  assert.ok(!hostKeyMatches(line, other));
  assert.ok(!hostKeyMatches(fp, other));
  assert.ok(!hostKeyMatches("garbage", key));
});
