/**
 * The trusted hop, checked against the same table mdrag and the wiki use.
 *
 * `contracts/trusted-hop-cases.json` is vendored from mdrag, which owns it. Three
 * runtimes construct this credential — mdrag's `middleware/hop.py`, the wiki's
 * `proxyFetch`, and this module — and every hop bug so far has been one of them
 * disagreeing with another about a row.
 *
 * Reading the file rather than restating the cases is the point: a case added
 * upstream fails whichever runtime has not handled it. What that cannot cover is
 * the vendoring itself — a copy can go stale between repos, so
 * `test_vendored_contract_matches_upstream` compares them byte-for-byte whenever
 * both are on disk (the umbrella checkout) and says plainly when it cannot.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  MdragHopError,
  mdragCall,
  mdragCredentialFromEnv,
  type MdragCredential,
} from "./mdrag-hop.js";

type HopCase = {
  name: string;
  why: string;
  incoming: Record<string, string>;
  service_identity: boolean;
  caller_email: string | null;
  destination?: string;
  applies_to: string[];
  not_applicable?: Record<string, string>;
  expect: { headers?: Record<string, string>; error?: string };
};

// npm runs scripts from the package directory, so the contract sits beside us.
const CONTRACT = path.resolve(process.cwd(), "contracts/trusted-hop-cases.json");
const SECRET = "test-internal-secret";
const OK_BASE = "http://mdrag-local:8017";

function contract(): { version: number; cases: HopCase[] } {
  assert.ok(
    existsSync(CONTRACT),
    `vendored contract missing at ${CONTRACT} — copy it from mdrag's contracts/`
  );
  const data = JSON.parse(readFileSync(CONTRACT, "utf8"));
  assert.equal(data.version, 1, "contract version changed — reread it before adapting");
  return data;
}

/** What this runtime presents for a row, given how that row's caller arrived. */
function credentialFor(c: HopCase): MdragCredential | null {
  const bearer = c.incoming.authorization;
  if (bearer) return { kind: "token", token: bearer.replace(/^Bearer\s+/i, "") };
  if (c.incoming["x-dc-token"]) return { kind: "token", token: c.incoming["x-dc-token"] };
  if (c.service_identity && c.caller_email) {
    return { kind: "vouch", internalSecret: SECRET, userEmail: c.caller_email };
  }
  return null;
}

describe("the trusted hop matches the shared contract", () => {
  for (const c of contract().cases) {
    const applies = c.applies_to.includes("trigger");

    it(`${c.name}${applies ? "" : " (not this runtime's case)"}`, () => {
      if (!applies) return;

      const credential = credentialFor(c);
      const base = c.destination ?? OK_BASE;

      if (c.expect.error === "no_credential") {
        // This runtime's form: nothing configured to present.
        assert.equal(credential, null, c.why);
        return;
      }

      assert.ok(credential, `${c.name}: no credential to build the call with`);

      if (c.expect.error === "stripping_destination") {
        assert.throws(
          () => mdragCall("/api/v1/ingest/web", credential, base),
          MdragHopError,
          c.why
        );
        return;
      }

      const call = mdragCall("/api/v1/ingest/web", credential, base);
      for (const [key, want] of Object.entries(c.expect.headers ?? {})) {
        // The wire location differs by design: mdrag's loopback re-presents
        // whichever header arrived, while this runtime always sends a token as
        // `Authorization` (the location verified end to end, see mdrag-hop.ts).
        const expected = want === "SECRET" ? SECRET : want;
        if (key === "X-DC-Token") {
          assert.equal(call.headers["Authorization"], `Bearer ${expected}`, c.why);
        } else {
          assert.equal(call.headers[key], expected, c.why);
        }
      }
    });
  }

  it("every row this runtime skips says why", () => {
    // Guards the loop: a row this runtime quietly stopped satisfying would
    // otherwise pass as a no-op. The one legitimate omission is recorded
    // upstream — this runtime requires BOTH halves for a vouch and falls
    // through to the token when there is nobody to name, which is deliberate
    // and stricter than mdrag. The table is what found that.
    for (const c of contract().cases) {
      if (c.applies_to.includes("trigger")) continue;
      assert.ok(
        c.not_applicable?.trigger,
        `${c.name}: omitted from this runtime with no reason recorded upstream`
      );
    }
  });

  it("the vendored contract matches upstream, when upstream is on disk", () => {
    // Only true in the umbrella checkout, where mdrag sits beside this repo.
    // Cross-repo drift cannot be enforced from here; this catches it where it
    // can and stays quiet — not falsely green — where it cannot.
    const upstream = path.resolve(
      process.cwd(),
      "../../../libraries/mdrag/contracts/trusted-hop-cases.json"
    );
    if (!existsSync(upstream)) {
      console.log(`  (upstream not on disk at ${upstream} — drift unchecked here)`);
      return;
    }
    assert.equal(
      readFileSync(CONTRACT, "utf8"),
      readFileSync(upstream, "utf8"),
      "vendored contract has drifted from mdrag's — re-copy it"
    );
  });
});

describe("mdragCall", () => {
  it("refuses a vouch aimed at the stripping host", () => {
    assert.throws(
      () =>
        mdragCall(
          "/api/v1/conversations/",
          { kind: "vouch", internalSecret: SECRET, userEmail: "u@example.com" },
          "https://wiki.datacrew.space"
        ),
      /strips X-Internal-Secret/
    );
  });

  it("allows a TOKEN call to that same host", () => {
    // The rule is scoped to the credential, not the hostname. `mdrag-primitives`
    // and `report-mdrag` depend on this; a blanket ban would have been simpler
    // and wrong.
    const call = mdragCall(
      "/api/v1/primitives/plan-research",
      { kind: "token", token: "dc_abc" },
      "https://wiki.datacrew.space"
    );

    assert.equal(call.url, "https://wiki.datacrew.space/api/v1/primitives/plan-research");
    assert.equal(call.headers["Authorization"], "Bearer dc_abc");
  });

  it("refuses the stripping host however it is spelled", () => {
    assert.throws(
      () =>
        mdragCall(
          "/api/v1/conversations/",
          { kind: "vouch", internalSecret: SECRET, userEmail: "u@example.com" },
          "HTTPS://WIKI.DATACREW.SPACE:443/api/v1"
        ),
      MdragHopError
    );
  });
});

describe("mdragCredentialFromEnv", () => {
  function withEnv(env: Record<string, string | undefined>, fn: () => void) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      fn();
    } finally {
      process.env = saved;
    }
  }

  it("prefers a vouch when both halves are present", () => {
    withEnv({ MDRAG_INTERNAL_SECRET: SECRET, MDRAG_TOKEN: "dc_abc" }, () => {
      assert.deepEqual(mdragCredentialFromEnv("u@example.com"), {
        kind: "vouch",
        internalSecret: SECRET,
        userEmail: "u@example.com",
      });
    });
  });

  it("falls through to the token when there is nobody to vouch for", () => {
    // Half a vouch is not a weaker vouch: X-User-Email alone is not a
    // credential, and mdrag rejects a tokenless /api/v1 request without the
    // secret. Sending it would be a 401 wearing a config error's clothes.
    withEnv({ MDRAG_INTERNAL_SECRET: SECRET, MDRAG_TOKEN: "dc_abc" }, () => {
      assert.deepEqual(mdragCredentialFromEnv(undefined), {
        kind: "token",
        token: "dc_abc",
      });
    });
  });

  it("throws when nothing is configured", () => {
    withEnv({ MDRAG_INTERNAL_SECRET: "", MDRAG_TOKEN: "" }, () => {
      assert.throws(() => mdragCredentialFromEnv("u@example.com"), MdragHopError);
    });
  });
});
