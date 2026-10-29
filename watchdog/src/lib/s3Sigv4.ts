import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature V4 for S3-compatible stores (bonker's MinIO), using only node:crypto: the
 * deployed task image has no S3 SDK and we do not want a new dependency for four request types.
 * Pure: the clock is injected. Checked against AWS's published S3 examples in s3Sigv4.test.ts.
 */

export interface S3Creds {
  accessKey: string;
  secretKey: string;
  region: string;
}

const sha256hex = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (key: string | Buffer, d: string) => createHmac("sha256", key).update(d).digest();

/** RFC 3986 percent-encoding, optionally leaving "/" alone (object keys). */
export function uriEncode(s: string, keepSlash: boolean): string {
  return [...Buffer.from(s, "utf8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/") ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function signingKey(c: S3Creds, day: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${c.secretKey}`, day), c.region), "s3"), "aws4_request");
}

function canonicalQuery(q: Record<string, string>): string {
  return Object.keys(q)
    .sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(q[k]!, false)}`)
    .join("&");
}

export interface PresignInput {
  method: "PUT" | "GET";
  /** e.g. http://bonker.lan:9010 (no trailing slash) */
  endpoint: string;
  /** "/bucket/key" (unencoded; encoded here) */
  path: string;
  expiresSeconds: number;
  now: Date;
}

/** Presigned URL, UNSIGNED-PAYLOAD (the uploader streams a file we have not read). */
export function presignUrl(c: S3Creds, i: PresignInput): string {
  const url = new URL(i.endpoint);
  const date = amzDate(i.now);
  const day = date.slice(0, 8);
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${c.accessKey}/${scope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(i.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const path = uriEncode(i.path, true);
  const canonical = [i.method, path, canonicalQuery(query), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256hex(canonical)].join("\n");
  const sig = createHmac("sha256", signingKey(c, day)).update(toSign).digest("hex");
  return `${url.protocol}//${url.host}${path}?${canonicalQuery(query)}&X-Amz-Signature=${sig}`;
}

export interface SignedRequestInput {
  method: "GET" | "HEAD" | "PUT" | "DELETE";
  endpoint: string;
  /** "/bucket/key" style path, already NOT encoded; encoded here. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  now: Date;
}

/** Header-signed request. Returns the URL and the headers to send (host is implied by the URL). */
export function signRequest(c: S3Creds, i: SignedRequestInput): { url: string; headers: Record<string, string> } {
  const url = new URL(i.endpoint);
  const date = amzDate(i.now);
  const day = date.slice(0, 8);
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const payloadHash = sha256hex(i.body ?? "");
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(i.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  const names = Object.keys(headers).sort();
  const path = uriEncode(i.path, true);
  const q = canonicalQuery(i.query ?? {});
  const canonical = [
    i.method,
    path,
    q,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256hex(canonical)].join("\n");
  const sig = createHmac("sha256", signingKey(c, day)).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope},SignedHeaders=${names.join(";")},Signature=${sig}`;
  const { host: _host, ...send } = headers;
  return { url: `${url.protocol}//${url.host}${path}${q ? `?${q}` : ""}`, headers: send };
}
