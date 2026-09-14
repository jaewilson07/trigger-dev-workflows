import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDeleteDocumentRequest,
  buildFlagDocumentRequest,
  buildUpdateDocumentRequest,
} from "./mdrag-document.js";
import type { MdragCredential } from "./mdrag-hop.js";

const TOKEN: MdragCredential = { kind: "token", token: "dc_abc" };
const VOUCH: MdragCredential = { kind: "vouch", internalSecret: "s3cr3t", userEmail: "u@example.com" };
const BASE = "http://mdrag-local:8017";

describe("buildUpdateDocumentRequest", () => {
  it("builds a PUT with the bearer token and JSON body", () => {
    const req = buildUpdateDocumentRequest("doc-1", { content: "new content" }, TOKEN, BASE);
    assert.equal(req.method, "PUT");
    assert.equal(req.url, "http://mdrag-local:8017/api/v1/documents/doc-1");
    assert.equal(req.headers["Authorization"], "Bearer dc_abc");
    assert.deepEqual(JSON.parse(req.body ?? "{}"), { content: "new content" });
  });

  it("URL-encodes the document uid", () => {
    const req = buildUpdateDocumentRequest("a/b c", { content: "x" }, TOKEN, BASE);
    assert.equal(req.url, "http://mdrag-local:8017/api/v1/documents/a%2Fb%20c");
  });

  it("carries an optional title and editor_note through untouched", () => {
    const req = buildUpdateDocumentRequest(
      "doc-1",
      { content: "x", title: "New Title", editor_note: "typo fix" },
      TOKEN,
      BASE
    );
    assert.deepEqual(JSON.parse(req.body ?? "{}"), {
      content: "x",
      title: "New Title",
      editor_note: "typo fix",
    });
  });

  it("builds a vouch call the same way a token call would", () => {
    const req = buildUpdateDocumentRequest("doc-1", { content: "x" }, VOUCH, BASE);
    assert.equal(req.headers["X-Internal-Secret"], "s3cr3t");
    assert.equal(req.headers["X-User-Email"], "u@example.com");
  });

  it("refuses a vouch aimed at wiki.datacrew.space", () => {
    assert.throws(() =>
      buildUpdateDocumentRequest("doc-1", { content: "x" }, VOUCH, "https://wiki.datacrew.space")
    );
  });

  it("allows a token call to wiki.datacrew.space", () => {
    const req = buildUpdateDocumentRequest("doc-1", { content: "x" }, TOKEN, "https://wiki.datacrew.space");
    assert.equal(req.url, "https://wiki.datacrew.space/api/v1/documents/doc-1");
  });
});

describe("buildDeleteDocumentRequest", () => {
  it("builds a DELETE with no body", () => {
    const req = buildDeleteDocumentRequest("doc-1", TOKEN, BASE);
    assert.equal(req.method, "DELETE");
    assert.equal(req.url, "http://mdrag-local:8017/api/v1/documents/doc-1");
    assert.equal(req.body, undefined);
  });
});

describe("buildFlagDocumentRequest", () => {
  it("builds a POST to the /flag subpath with no body", () => {
    const req = buildFlagDocumentRequest("doc-1", TOKEN, BASE);
    assert.equal(req.method, "POST");
    assert.equal(req.url, "http://mdrag-local:8017/api/v1/documents/doc-1/flag");
    assert.equal(req.body, undefined);
  });
});
