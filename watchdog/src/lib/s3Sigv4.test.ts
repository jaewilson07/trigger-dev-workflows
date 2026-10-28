import assert from "node:assert/strict";
import { test } from "node:test";
import { presignUrl, signRequest, uriEncode } from "./s3Sigv4.js";

// AWS docs "Authenticating Requests: Using Query Parameters" and "Signature Calculations: Header-Based" examples.
const AWS = { accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
const NOW = new Date("2013-05-24T00:00:00Z");

test("presigned GET matches the AWS documented signature", () => {
  const url = presignUrl(AWS, { method: "GET", endpoint: "https://examplebucket.s3.amazonaws.com", path: "/test.txt", expiresSeconds: 86400, now: NOW });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test("header-signed GET with Range matches the AWS documented signature", () => {
  const { headers } = signRequest(AWS, {
    method: "GET",
    endpoint: "https://examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    headers: { Range: "bytes=0-9" },
    now: NOW,
  });
  assert.match(headers.authorization!, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test("header-signed bucket list matches the AWS documented signature", () => {
  const { headers, url } = signRequest(AWS, {
    method: "GET",
    endpoint: "https://examplebucket.s3.amazonaws.com",
    path: "/",
    query: { "max-keys": "2", prefix: "J" },
    now: NOW,
  });
  assert.match(headers.authorization!, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
  assert.equal(url, "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J");
});

test("path-style presign is deterministic, expiring and never contains the secret", () => {
  const a = presignUrl(AWS, { method: "PUT", endpoint: "http://bonker.lan:9010", path: "/paperclip-backups/daily/20261029T091500Z/paperclip.dump", expiresSeconds: 3600, now: NOW });
  const b = presignUrl(AWS, { method: "PUT", endpoint: "http://bonker.lan:9010", path: "/paperclip-backups/daily/20261029T091500Z/paperclip.dump", expiresSeconds: 3600, now: NOW });
  assert.equal(a, b);
  assert.ok(a.startsWith("http://bonker.lan:9010/paperclip-backups/daily/20261029T091500Z/paperclip.dump?"));
  assert.ok(a.includes("X-Amz-Expires=3600") && a.includes("X-Amz-SignedHeaders=host"));
  assert.ok(!a.includes(AWS.secretKey));
});

test("uriEncode leaves slash only when asked", () => {
  assert.equal(uriEncode("a b/c", true), "a%20b/c");
  assert.equal(uriEncode("a b/c", false), "a%20b%2Fc");
});
