/**
 * Collection routing, checked against the same table mdrag owns.
 *
 * `contracts/collection-routing-cases.json` is vendored from mdrag. Reading the
 * file rather than restating the cases is the point — a row added upstream
 * fails this runtime if it hasn't been updated too. What that cannot cover is
 * the vendoring itself, so the last test here compares the two copies
 * byte-for-byte whenever both are on disk (the umbrella checkout).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { COLLECTION_MAP, DEFAULT_COLLECTION, collectionForRemoteUrl, collectionForRepoSlug } from "./collection-routing.js";

type Case = { name: string; repo_slug?: string; remote_url?: string; expect_collection: string };
type Contract = {
  version: number;
  default_collection: string;
  routes: Array<{ repo_slug: string; collection: string }>;
  cases: Case[];
};

const CONTRACT = path.resolve(process.cwd(), "contracts/collection-routing-cases.json");

function contract(): Contract {
  assert.ok(
    existsSync(CONTRACT),
    `vendored contract missing at ${CONTRACT} — copy it from mdrag's contracts/`
  );
  const data = JSON.parse(readFileSync(CONTRACT, "utf8")) as Contract;
  assert.equal(data.version, 1, "contract version changed — reread it before adapting");
  return data;
}

describe("collection routing matches the shared contract", () => {
  it("the module table matches the contract's routes", () => {
    const c = contract();
    assert.equal(DEFAULT_COLLECTION, c.default_collection);
    const expected: Record<string, string> = {};
    for (const row of c.routes) expected[row.repo_slug] = row.collection;
    assert.deepEqual(COLLECTION_MAP, expected);
  });

  for (const c of contract().cases) {
    it(c.name, () => {
      const got = c.repo_slug !== undefined ? collectionForRepoSlug(c.repo_slug) : collectionForRemoteUrl(c.remote_url ?? "");
      assert.equal(got, c.expect_collection, c.name);
    });
  }

  it("the vendored contract matches upstream, when upstream is on disk", () => {
    const upstream = path.resolve(
      process.cwd(),
      "../../../libraries/mdrag/contracts/collection-routing-cases.json"
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
