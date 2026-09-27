import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSyncCredentials } from "./infisical.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    process.env = saved;
  }
}

test("resolveSyncCredentials: a prod deploy without the machine identity fails loudly", () => {
  // Silently syncing nothing hid a missing JAEWILSON07_GH_PAT for weeks
  // (2026-09-27): values from earlier syncs survived, new names never arrived.
  withEnv({ INFISICAL_CLIENT_ID: undefined, INFISICAL_CLIENT_SECRET: undefined }, () => {
    assert.throws(() => resolveSyncCredentials("prod"), /INFISICAL_CLIENT_ID\/INFISICAL_CLIENT_SECRET/);
    assert.throws(() => resolveSyncCredentials("staging"), /INFISICAL_CLIENT_ID/);
  });
  withEnv({ INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: undefined }, () => {
    assert.throws(() => resolveSyncCredentials("prod"), /INFISICAL_CLIENT_SECRET/);
  });
});

test("resolveSyncCredentials: local `trigger dev` without credentials skips the sync", () => {
  withEnv({ INFISICAL_CLIENT_ID: undefined, INFISICAL_CLIENT_SECRET: undefined }, () => {
    assert.equal(resolveSyncCredentials("dev"), null);
  });
});

test("resolveSyncCredentials: returns the pair when both are present", () => {
  withEnv({ INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "s" }, () => {
    assert.deepEqual(resolveSyncCredentials("prod"), { clientId: "id", clientSecret: "s" });
  });
});
