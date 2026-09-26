/**
 * Fingerprint a task failure so the same underlying bug — even across many
 * runs with different ids/timestamps — resolves to the same GitHub issue
 * instead of a new one every run. jaewilson07/trigger-dev-workflows#206.
 *
 * Fingerprint = task id + error name + a NORMALIZED error message (numbers,
 * hex/uuids, timestamps, and id-bearing paths stripped out, since those are
 * exactly the parts that differ run-to-run for what is otherwise the same
 * failure). Callers must pass an already-redacted message (see
 * `redactSecrets.ts`) — normalization alone is not a secret-safety
 * mechanism, it's a dedup mechanism.
 *
 * The fingerprint is embedded verbatim as a hidden HTML comment marker in
 * the issue body (`<!-- trigger-failure:FINGERPRINT -->`) and searched for
 * on subsequent runs — see `failureAlertReporter.ts`.
 */

import { createHash } from "node:crypto";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
// A "hex" run of 6+ chars — commit SHAs, run ids, etc. Runs before the
// generic digit-strip below since a hex string is also a digit-heavy string.
const HEX_RE = /\b[0-9a-f]{6,}\b/gi;
// A path segment that contains at least one digit — e.g. `/tmp/run-8f3a2/x`,
// `/home/user/.cache/12345/out.json`. Left-anchored on a path separator so
// this doesn't eat unrelated prose.
const PATH_WITH_ID_RE = /(?:^|[\s(])(?:\/|\.\/|~\/)[^\s)]*\d[^\s)]*/g;
const DIGIT_RE = /\d+/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Strip run-specific noise from an error message, leaving only the parts
 * that identify WHAT went wrong rather than WHEN/WHICH run.
 */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(UUID_RE, "<id>")
    .replace(TIMESTAMP_RE, "<ts>")
    .replace(PATH_WITH_ID_RE, (m) => `${m[0] === "(" || m[0] === " " ? m[0] : ""}<path>`)
    .replace(HEX_RE, "<hex>")
    .replace(DIGIT_RE, "<n>")
    .replace(WHITESPACE_RE, " ")
    .trim()
    .toLowerCase();
}

/** Stable, short (16 hex chars) fingerprint for a task + error name + message. */
export function buildFailureFingerprint(taskId: string, errorName: string, message: string): string {
  const normalized = normalizeErrorMessage(message);
  const raw = `${taskId}|${errorName}|${normalized}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

const FINGERPRINT_MARKER_RE = /<!--\s*trigger-failure:([0-9a-f]{16})\s*-->/;

/** The hidden marker embedded in a filed issue's body. */
export function buildFingerprintMarker(fingerprint: string): string {
  return `<!-- trigger-failure:${fingerprint} -->`;
}

/** Extract a fingerprint marker from an issue body, if present. */
export function extractFingerprintMarker(body: string): string | null {
  const m = FINGERPRINT_MARKER_RE.exec(body);
  return m ? m[1] : null;
}
