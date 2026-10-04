import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "./redactSecrets.js";

test("redactSecrets: masks a GitHub PAT (classic ghp_ prefix)", () => {
  const out = redactSecrets("clone failed: remote rejected ghp_1234567890abcdef1234567890ABCDEF1234");
  assert.ok(!out.includes("ghp_"), "raw token prefix must not survive");
  assert.match(out, /\[REDACTED\]/);
});

test("redactSecrets: masks a fine-grained GitHub PAT (github_pat_ prefix)", () => {
  const out = redactSecrets("auth: github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL");
  assert.ok(!out.includes("github_pat_"));
  assert.match(out, /\[REDACTED\]/);
});

test("redactSecrets: masks an OpenAI/Anthropic-style sk- key", () => {
  const out = redactSecrets("Authorization: Bearer sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  assert.ok(!/sk-ant-api03-[A-Za-z0-9]/.test(out));
  assert.match(out, /\[REDACTED\]/);
});

test("redactSecrets: masks a Slack bot token (xoxb-)", () => {
  // Built by concatenation (not a literal token in the diff) so GitHub's
  // push-protection secret scanner — which flags this exact shape even as
  // fixture data — doesn't block the push. Still exercises the real regex.
  const fakeToken = ["xoxb", "1234567890", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("-");
  const out = redactSecrets(`slack post failed with ${fakeToken}`);
  assert.ok(!out.includes("1234567890-ABCDEFGHIJKLMNOPQRSTUVWX"));
  assert.match(out, /\[REDACTED\]/);
});

test("redactSecrets: masks a JWT", () => {
  // Built by concatenation (not a literal token in the diff) so a
  // secret-scanner flagging this exact shape as a "JSON Web Token" — even
  // as fixture data — doesn't trip on it. Still exercises the real regex.
  const jwt = [
    ["eyJhbGciOiJIUzI1", "NiJ9"].join(""),
    ["eyJzdWIiOiIxMjM0", "NTY3ODkwIiwibmFt", "ZSI6IkpvaG4gRG9l", "In0"].join(""),
    ["dQw4w9WgXcQ_ABCD", "EFGHIJKLMNOP"].join(""),
  ].join(".");
  const out = redactSecrets(`token invalid: ${jwt}`);
  assert.ok(!out.includes(jwt));
  assert.match(out, /\[REDACTED\]/);
});

test("redactSecrets: masks password= assignments but keeps the key name", () => {
  const out = redactSecrets("connect failed: postgres://host/db?password=hunter2SuperSecret");
  assert.ok(!out.includes("hunter2SuperSecret"));
  assert.match(out, /password=\[REDACTED\]/);
});

test("redactSecrets: masks a URL's userinfo", () => {
  const out = redactSecrets("fetch https://myuser:s3cr3tPassw0rd@example.com/api failed with 401");
  assert.ok(!out.includes("s3cr3tPassw0rd"));
  assert.match(out, /https:\/\/\[REDACTED\]@example\.com/);
});

test("redactSecrets: masks a long generic hex run (catch-all)", () => {
  const out = redactSecrets("panic: key deadbeefdeadbeefdeadbeefdeadbeefdeadbeef rejected");
  assert.ok(!out.includes("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"));
});

test("redactSecrets: masks a long base64-shaped run (catch-all)", () => {
  // Built by concatenation (not a literal high-entropy string in the diff)
  // for the same secret-scanner reason as the JWT fixture above.
  const fakeCredential = [
    "QUJDREVGR0hJSk",
    "tMTU5PUFFSU1RV",
    "VldYWVowMTIzND",
    "U2Nzg5QUJDREVG",
    "R0hJSg==",
  ].join("");
  const out = redactSecrets(`bad credential: ${fakeCredential}`);
  assert.ok(!out.includes(fakeCredential));
});

test("redactSecrets: leaves ordinary error text untouched", () => {
  const message = "connection refused at 127.0.0.1:5432 after 3 retries";
  assert.equal(redactSecrets(message), message);
});

test("redactSecrets: leaves a short task id / kebab-case identifier untouched", () => {
  const message = "task crew-rag-domo-scrape failed on version 20260926.1";
  assert.equal(redactSecrets(message), message);
});
