/**
 * Pure logic for the daily token-health watchdog
 * (`../trigger/tokenHealthReport.ts`).
 *
 * Born from 2026-09-28: four Infisical-held API tokens had been revoked
 * weeks earlier with nothing noticing — consumers just got 401s. Two token
 * families are in scope, both sent as `Authorization: Bearer <token>`:
 *
 * - `dc_` — datacrew.space JWTs. Detect + report only; minting one back
 *   requires a manual-approval `token-mint` entitlement this pipeline does
 *   not have (see the rotation runbook in infra-bonker for the by-hand
 *   procedure).
 * - `mat_` — mdrag access tokens, mintable by the rotation runbook.
 *
 * Everything here is side-effect-free: no network, no filesystem, no
 * Infisical/mdrag client. `../trigger/tokenHealthReport.ts` supplies the
 * secrets (via `@datacrew/trigger-shared`'s `listAllSecrets`) and the
 * liveness results (via a plain `fetch` against mdrag's `/api/v1/users/me`),
 * and this module turns those into a report.
 *
 * NEVER hold a full token value in anything this module returns or a caller
 * logs — only `valuePrefix` (first 4 chars), consistent with the "no token
 * values on disk/in logs" rule that governs this whole feature.
 */

import { createHash } from "node:crypto";

export type TokenPrefix = "dc" | "mat";

/** One secret as read from Infisical, before any dc_/mat_ filtering. */
export type SecretRecord = {
  name: string;
  path: string;
  environment: string;
  /** Expanded value — references resolved, the value a consumer actually presents. */
  value: string;
  /** Raw, unexpanded value. Equal to `value` for a secret that is not itself a reference. */
  rawValue: string;
};

export type LivenessStatus = "live" | "dead" | "unknown";

const REFERENCE_PATTERN = /^\$\{([^}]+)\}$/;

/** `dc_...` / `mat_...`, or `null` for anything else (not a tracked token). */
export function classifyPrefix(value: string): TokenPrefix | null {
  if (value.startsWith("dc_")) return "dc";
  if (value.startsWith("mat_")) return "mat";
  return null;
}

/** First 4 chars only — enough to tell tokens apart in a report, never the whole value. */
export function valuePrefix4(value: string): string {
  return value.slice(0, 4);
}

/**
 * `${prod.datacrew.DATACREW_API_TOKEN}` -> `"prod.datacrew.DATACREW_API_TOKEN"`.
 * `null` when `rawValue` is not an Infisical reference template.
 */
export function parseReferenceTarget(rawValue: string): string | null {
  const m = REFERENCE_PATTERN.exec(rawValue.trim());
  return m ? m[1] : null;
}

/** Short, non-reversible key for durable dead-since state — never the token itself. */
export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export type TrackedSecret = SecretRecord & {
  prefix: TokenPrefix;
  /** Non-null when this name's raw value is an Infisical reference, not the token itself. */
  referenceTarget: string | null;
};

/** Filters to dc_/mat_-prefixed secrets (by expanded value) and classifies each. */
export function trackSecrets(records: SecretRecord[]): TrackedSecret[] {
  const out: TrackedSecret[] = [];
  for (const record of records) {
    const prefix = classifyPrefix(record.value);
    if (!prefix) continue;
    out.push({
      ...record,
      prefix,
      referenceTarget: parseReferenceTarget(record.rawValue),
    });
  }
  return out;
}

export type ValueGroup = {
  value: string;
  prefix: TokenPrefix;
  entries: TrackedSecret[];
};

/**
 * Groups tracked secrets by their EXPANDED value, so a reference and its
 * source (or two names pasted with the same literal token) are checked for
 * liveness exactly once, not once per name.
 */
export function groupByValue(secrets: TrackedSecret[]): ValueGroup[] {
  const map = new Map<string, TrackedSecret[]>();
  for (const secret of secrets) {
    const bucket = map.get(secret.value);
    if (bucket) bucket.push(secret);
    else map.set(secret.value, [secret]);
  }
  return [...map.entries()].map(([value, entries]) => ({ value, prefix: entries[0].prefix, entries }));
}

export type DuplicateWarning = {
  prefix: TokenPrefix;
  valuePrefix: string;
  /** Names that hold this value DIRECTLY (not via a reference) — the actual "two copies" case. */
  names: { name: string; path: string; environment: string }[];
};

/**
 * A group is a duplicate-warning case only when >=2 names hold the value
 * DIRECTLY. A reference pointing at a source is not a duplicate by the house
 * rule ("one value, one name") — it IS the one name, referenced from
 * elsewhere, which is the sanctioned way to reuse a value.
 */
export function findDuplicateWarnings(groups: ValueGroup[]): DuplicateWarning[] {
  const warnings: DuplicateWarning[] = [];
  for (const group of groups) {
    const direct = group.entries.filter((e) => e.referenceTarget === null);
    if (direct.length > 1) {
      warnings.push({
        prefix: group.prefix,
        valuePrefix: valuePrefix4(group.value),
        names: direct.map((e) => ({ name: e.name, path: e.path, environment: e.environment })),
      });
    }
  }
  return warnings;
}

export type DeadEntry = {
  name: string;
  path: string;
  environment: string;
  prefix: TokenPrefix;
  valuePrefix: string;
  /** Non-null when this name is an Infisical reference; report it as pointing at its source. */
  referenceTarget: string | null;
  /** ISO timestamp this value was FIRST observed dead, across runs. */
  deadSince: string;
};

export type UnknownEntry = {
  name: string;
  path: string;
  environment: string;
  prefix: TokenPrefix;
  reason: string;
};

export type TokenHealthReport = {
  distinctValuesChecked: number;
  deadEntries: DeadEntry[];
  duplicates: DuplicateWarning[];
  unknownEntries: UnknownEntry[];
};

/**
 * `deadSinceByHash` is durable cross-run state (see `hashValue`): keyed by a
 * hash of the value, not the value itself, so a token's plaintext is never
 * written into a second Infisical secret just to track "since when".
 */
export function buildReport(
  groups: ValueGroup[],
  liveness: Map<string, LivenessStatus>,
  deadSinceByHash: Map<string, string>,
  nowIso: string
): TokenHealthReport {
  const deadEntries: DeadEntry[] = [];
  const unknownEntries: UnknownEntry[] = [];

  for (const group of groups) {
    const status = liveness.get(group.value) ?? "unknown";
    if (status === "dead") {
      const since = deadSinceByHash.get(hashValue(group.value)) ?? nowIso;
      for (const entry of group.entries) {
        deadEntries.push({
          name: entry.name,
          path: entry.path,
          environment: entry.environment,
          prefix: entry.prefix,
          valuePrefix: valuePrefix4(group.value),
          referenceTarget: entry.referenceTarget,
          deadSince: since,
        });
      }
    } else if (status === "unknown") {
      for (const entry of group.entries) {
        unknownEntries.push({
          name: entry.name,
          path: entry.path,
          environment: entry.environment,
          prefix: entry.prefix,
          reason: "liveness check could not be completed (network/HTTP error other than 401)",
        });
      }
    }
  }

  return {
    distinctValuesChecked: groups.length,
    deadEntries,
    duplicates: findDuplicateWarnings(groups),
    unknownEntries,
  };
}

/**
 * Merges today's dead-value hashes into the persisted "dead since" state:
 * keeps a still-dead value's original first-seen date, drops a value that
 * recovered (no longer dead this run), and adds newly-dead values at `nowIso`.
 *
 * Pure — the caller reads the previous state from and writes the result back
 * to Infisical (the one durable store every task in this repo already trusts;
 * see `infisical.ts`'s `setSecret` doc comment on that pattern).
 */
export function updateDeadSinceState(
  previous: Record<string, string>,
  currentlyDeadValues: string[],
  nowIso: string
): Record<string, string> {
  const currentHashes = new Set(currentlyDeadValues.map(hashValue));
  const next: Record<string, string> = {};
  for (const hash of currentHashes) {
    next[hash] = previous[hash] ?? nowIso;
  }
  return next;
}

/**
 * `true` when `next` differs from `previous` by canonical (key-sorted) JSON —
 * used by the caller to skip writing `saveDeadSinceState` when nothing
 * changed, so a healthy day doesn't create a new Infisical secret version
 * just to persist the same `{}`/unchanged map.
 */
export function deadSinceStateChanged(
  previous: Record<string, string>,
  next: Record<string, string>
): boolean {
  return canonicalizeState(previous) !== canonicalizeState(next);
}

function canonicalizeState(state: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(state)
      .sort()
      .map((key) => [key, state[key]])
  );
}

/** `null` when there is nothing worth alerting on (no dead tokens this run). */
export function formatAlertMessage(report: TokenHealthReport): string | null {
  if (report.deadEntries.length === 0) return null;

  const lines = [
    `Token health check found ${report.deadEntries.length} dead token name(s) ` +
      `(checked ${report.distinctValuesChecked} distinct value(s)):`,
  ];
  for (const entry of report.deadEntries) {
    const ref = entry.referenceTarget ? ` (reference -> ${entry.referenceTarget})` : "";
    lines.push(
      `  - ${entry.name} [${entry.path}, ${entry.environment}] ${entry.valuePrefix}*** ` +
        `dead since ${entry.deadSince}${ref}`
    );
  }
  if (report.duplicates.length > 0) {
    lines.push(`Also found ${report.duplicates.length} duplicate-value warning(s):`);
    for (const dup of report.duplicates) {
      lines.push(`  - ${dup.names.map((n) => `${n.name} [${n.path}, ${n.environment}]`).join(" == ")}`);
    }
  }
  if (report.unknownEntries.length > 0) {
    lines.push(`${report.unknownEntries.length} value(s) could not be checked this run (network/HTTP error).`);
  }
  return lines.join("\n");
}

/** Human-readable summary for logs even on a fully-healthy run. */
export function formatSummary(report: TokenHealthReport): string {
  return (
    `token-health: ${report.distinctValuesChecked} distinct value(s) checked, ` +
    `${report.deadEntries.length} dead, ${report.duplicates.length} duplicate warning(s), ` +
    `${report.unknownEntries.length} unknown`
  );
}
