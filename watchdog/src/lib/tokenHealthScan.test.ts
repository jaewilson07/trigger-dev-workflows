/**
 * Not part of watchdog's ad-hoc `npm test` `tsc`-then-`node --test` harness
 * (`package.json`'s `test` script) — `tokenHealthScan.ts` imports
 * `@datacrew/trigger-shared`, whose `main` points at raw `.ts` source
 * (resolved by trigger.dev's bundler at deploy time, not by plain
 * `node --test`; see `tokenHealthScan.ts`'s doc comment, same reasoning as
 * `failureAlertFetch.ts`). Covered instead by `npm run typecheck`
 * (`moduleResolution: "Bundler"` in `tsconfig.json` resolves it fine) and,
 * for real behavior, `trigger.dev dev`. Kept here — not deleted — as the
 * test-first record of this module's contract, same as `vendorDocsMirror.ts`
 * has no unit test file of its own but is exercised through `vendorDocsIngest.test.ts`'s
 * injected fakes; here the injection seam is `getImpl`/`setImpl` below.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDeadSinceState, saveDeadSinceState } from "./tokenHealthScan.js";

test("loadDeadSinceState: empty object when nothing has been stored yet", async () => {
  const getImpl = (async () => {
    throw new Error("Secret TOKEN_HEALTH_DEAD_SINCE_STATE not found in Infisical /datacrew");
  }) as unknown as typeof import("@datacrew/trigger-shared").getSecret;
  assert.deepEqual(await loadDeadSinceState(getImpl), {});
});

test("loadDeadSinceState: parses stored JSON", async () => {
  const getImpl = (async () =>
    JSON.stringify({ abc123: "2026-09-01T00:00:00.000Z" })) as unknown as typeof import("@datacrew/trigger-shared").getSecret;
  assert.deepEqual(await loadDeadSinceState(getImpl), { abc123: "2026-09-01T00:00:00.000Z" });
});

test("saveDeadSinceState: writes JSON via upsert mode", async () => {
  const calls: Array<{ key: string; value: string; opts: unknown }> = [];
  const setImpl = (async (key: string, value: string, opts: unknown) => {
    calls.push({ key, value, opts });
  }) as unknown as typeof import("@datacrew/trigger-shared").setSecret;
  await saveDeadSinceState({ abc: "2026-09-01T00:00:00.000Z" }, setImpl);
  assert.equal(calls.length, 1);
  const [written] = calls;
  assert.equal(written.key, "TOKEN_HEALTH_DEAD_SINCE_STATE");
  assert.deepEqual(JSON.parse(written.value), { abc: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(written.opts, { path: "/datacrew", mode: "upsert" });
});
