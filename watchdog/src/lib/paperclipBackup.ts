/**
 * Pure logic for the Paperclip backup task (trigger.dev owns the schedule; cubby executes the backup via
 * infra-cubby apps/paperclip/backup/paperclip-backup-run; the verified copy lives in bonker's MinIO).
 * No IO here: key layout, manifest parsing, retention, freshness, alert text.
 */

export const BUCKET = "paperclip-backups";
export const DAILY_KEEP = 14;
export const WEEKLY_KEEP = 8;
export const MAX_AGE_HOURS = 26;
export type Tier = "daily" | "weekly";

export const FILE_NAMES = { dump: "paperclip.dump", essentials: "paperclip-essentials.tar.gz", manifest: "manifest.json" } as const;
export type Part = keyof typeof FILE_NAMES;

/** 20261029T091500Z: sorts lexicographically == chronologically. */
export function runId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function objectKey(tier: Tier, id: string, part: Part): string {
  return `${tier}/${id}/${FILE_NAMES[part]}`;
}

/** Sunday in America/Denver (the schedule's timezone) gets a weekly copy. */
export function isWeeklyDay(now: Date, timeZone = "America/Denver"): boolean {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(now) === "Sun";
}

export interface BackupManifest {
  ok: true;
  startedAt: string;
  seconds: number;
  dump: { file: string; bytes: number; sha256: string };
  essentials: { file: string; bytes: number; sha256: string };
  restore: { issues: number; agents: number; liveIssues: number; liveAgents: number };
  uploaded: boolean;
}

/** The runner prints progress on stderr and a one-line JSON manifest last; output is merged, so scan from the end. */
export function parseManifest(output: string): BackupManifest {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.startsWith("{")) continue;
    try {
      const m = JSON.parse(l) as BackupManifest;
      if (m.ok === true && m.dump?.bytes > 0 && m.essentials?.bytes > 0 && m.restore?.issues > 0 && m.restore?.agents > 0) return m;
    } catch {
      /* keep scanning */
    }
  }
  throw new Error("no valid backup manifest in runner output");
}

export interface ObjectInfo {
  key: string;
  size: number;
  lastModified: string;
}

export interface ListPage {
  objects: ObjectInfo[];
  nextToken: string | null;
}

const xmlUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function parseListObjectsV2(xml: string): ListPage {
  const objects: ObjectInfo[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1]!;
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
    const lm = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(body)?.[1];
    if (key !== undefined && size !== undefined && lm !== undefined) objects.push({ key: xmlUnescape(key), size: Number(size), lastModified: lm });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, nextToken: truncated && token ? xmlUnescape(token) : null };
}

/** Run ids present under `tier/`, newest first. */
export function runIdsOf(keys: string[], tier: Tier): string[] {
  const ids = new Set<string>();
  for (const k of keys) {
    const m = new RegExp(`^${tier}/(\\d{8}T\\d{6}Z)/`).exec(k);
    if (m) ids.add(m[1]!);
  }
  return [...ids].sort().reverse();
}

/** Keys to delete so only the newest `keep` runs of `tier` remain. Unknown keys are never selected. */
export function selectDeletions(keys: string[], tier: Tier, keep: number): string[] {
  const doomed = new Set(runIdsOf(keys, tier).slice(keep));
  return keys.filter((k) => {
    const m = new RegExp(`^${tier}/(\\d{8}T\\d{6}Z)/`).exec(k);
    return m !== null && doomed.has(m[1]!);
  });
}

export function idToDate(id: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
  if (!m) throw new Error(`bad run id ${id}`);
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

export interface Freshness {
  ok: boolean;
  newestRunId: string | null;
  ageHours: number | null;
}

/** Newest COMPLETE daily run (all three objects present, i.e. verified and uploaded) must be younger than maxHours. */
export function freshness(keys: string[], now: Date, maxHours = MAX_AGE_HOURS): Freshness {
  const complete = runIdsOf(keys, "daily").filter((id) =>
    (Object.keys(FILE_NAMES) as Part[]).every((p) => keys.includes(objectKey("daily", id, p))),
  );
  const newest = complete[0] ?? null;
  if (!newest) return { ok: false, newestRunId: null, ageHours: null };
  const ageHours = (now.getTime() - idToDate(newest).getTime()) / 3_600_000;
  return { ok: ageHours <= maxHours, newestRunId: newest, ageHours: Math.round(ageHours * 10) / 10 };
}

export function successSummary(m: BackupManifest, id: string): string {
  const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;
  return `paperclip backup ${id}: dump ${mb(m.dump.bytes)}, essentials ${mb(m.essentials.bytes)}, restore check issues=${m.restore.issues} agents=${m.restore.agents} (live ${m.restore.liveIssues}/${m.restore.liveAgents})`;
}
