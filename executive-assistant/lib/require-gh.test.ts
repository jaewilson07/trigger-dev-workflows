import assert from "node:assert/strict";
import { test } from "node:test";
import { assertGhAvailable } from "./require-gh.js";

/**
 * Regression coverage for the daily-standup silent-degrade bug diagnosed
 * 2026-09-26: no project image installed `gh`, and both Python scripts the
 * task runs treat a missing `gh` as an empty/vacuous result rather than an
 * error — `audit-branch-protection --enforce` in particular would exit 0
 * (as if every repo were verified protected) purely because `gh` wasn't
 * there to check. `assertGhAvailable()` is the fail-loud gate `daily-standup.ts`
 * now calls before either script runs.
 */
test("assertGhAvailable resolves when the injected check succeeds", async () => {
  await assert.doesNotReject(() => assertGhAvailable(async () => "gh version 2.101.0"));
});

test("assertGhAvailable throws a clear, actionable error when the check fails", async () => {
  await assert.rejects(
    () =>
      assertGhAvailable(async () => {
        throw new Error("spawn gh ENOENT");
      }),
    /gh \(GitHub CLI\) not found on PATH.*gitAndUv\(\{ gh: true \}\).*spawn gh ENOENT/s
  );
});
