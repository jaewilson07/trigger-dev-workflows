import assert from "node:assert/strict";
import { test } from "node:test";
import {
  freshness,
  isWeeklyDay,
  objectKey,
  parseListObjectsV2,
  parseManifest,
  runId,
  selectDeletions,
} from "./paperclipBackup.js";

const M = '{"ok":true,"startedAt":"x","seconds":9,"dump":{"file":"d","bytes":5,"sha256":"a"},"essentials":{"file":"e","bytes":6,"sha256":"b"},"restore":{"issues":1006,"agents":18,"liveIssues":1006,"liveAgents":18},"uploaded":true}';

test("runId is compact UTC and sorts chronologically", () => {
  assert.equal(runId(new Date("2026-10-29T09:15:00.123Z")), "20261029T091500Z");
});

test("parseManifest takes the last JSON line from merged stderr/stdout", () => {
  const m = parseManifest(`paperclip-backup: pg_dump -> x\n{not json\n${M}\n`);
  assert.equal(m.restore.issues, 1006);
});

test("parseManifest rejects empty restore counts and missing manifests", () => {
  assert.throws(() => parseManifest("paperclip-backup: ERROR: boom"));
  assert.throws(() => parseManifest(M.replace('"issues":1006', '"issues":0')));
});

const keysFor = (tier: string, ids: string[]) => ids.flatMap((i) => [`${tier}/${i}/paperclip.dump`, `${tier}/${i}/paperclip-essentials.tar.gz`, `${tier}/${i}/manifest.json`]);

test("selectDeletions keeps the newest N runs per tier and ignores foreign keys", () => {
  const ids = Array.from({ length: 16 }, (_, i) => `202610${String(i + 1).padStart(2, "0")}T091500Z`);
  const keys = [...keysFor("daily", ids), ...keysFor("weekly", ids.slice(0, 3)), "README.txt", "daily/not-a-run/x"];
  const del = selectDeletions(keys, "daily", 14);
  assert.equal(del.length, 6); // 2 oldest runs x 3 objects
  assert.ok(del.every((k) => k.startsWith("daily/20261001T") || k.startsWith("daily/20261002T")));
  assert.deepEqual(selectDeletions(keys, "weekly", 8), []);
});

test("freshness: ok under 26h, stale over, and incomplete runs do not count", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  assert.equal(freshness(keysFor("daily", ["20261029T090000Z"]), now).ok, true);
  assert.equal(freshness(keysFor("daily", ["20261027T090000Z"]), now).ok, false);
  const partial = keysFor("daily", ["20261029T090000Z"]).slice(0, 2).concat(keysFor("daily", ["20261027T090000Z"]));
  const f = freshness(partial, now);
  assert.equal(f.ok, false);
  assert.equal(f.newestRunId, "20261027T090000Z");
  assert.deepEqual(freshness([], now), { ok: false, newestRunId: null, ageHours: null });
});

test("parseListObjectsV2 reads keys, sizes, truncation token", () => {
  const xml = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken>
  <Contents><Key>daily/20261029T091500Z/manifest.json</Key><LastModified>2026-10-29T09:16:00.000Z</LastModified><Size>321</Size></Contents></ListBucketResult>`;
  const p = parseListObjectsV2(xml);
  assert.deepEqual(p.objects, [{ key: "daily/20261029T091500Z/manifest.json", size: 321, lastModified: "2026-10-29T09:16:00.000Z" }]);
  assert.equal(p.nextToken, "tok&1");
});

test("isWeeklyDay uses Denver time", () => {
  assert.equal(isWeeklyDay(new Date("2026-11-01T08:00:00Z")), true); // Sun 02:00 MDT... Sunday
  assert.equal(isWeeklyDay(new Date("2026-11-02T03:00:00Z")), true); // Sun 20:00 MST
  assert.equal(isWeeklyDay(new Date("2026-11-02T08:00:00Z")), false); // Mon
  assert.equal(objectKey("weekly", "X", "dump"), "weekly/X/paperclip.dump");
});
