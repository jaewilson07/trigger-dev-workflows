// Checks the dead-man's switch against a stub Trigger.dev API, including the
// rss-feed-factory watch: weekly-sweep (Thursday 21:00 UTC cron) read with its
// own project key, a threshold past one weekly period, and a 14-day window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

const HOUR = 3_600_000;

async function runDeadman(runs, extraArgs = [], env = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: runs }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const child = spawn(
    process.execPath,
    [new URL("./trigger-deadman.mjs", import.meta.url).pathname, "--dry-run", ...extraArgs],
    { env: { PATH: process.env.PATH, TRIGGER_API_URL: `http://127.0.0.1:${port}`, ...env } }
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  return { code, out, seen };
}

const sweepArgs = [
  "--task=weekly-sweep",
  "--max-age-hours=200",
  "--freshness-window-days=14",
  "--key-env=TRIGGER_SECRET_KEY_RSS_FEED_FACTORY",
];
const sweepEnv = { TRIGGER_SECRET_KEY_RSS_FEED_FACTORY: "tr_prod_rff" };
const run = (ageH, status = "COMPLETED", extra = {}) => ({
  taskIdentifier: "weekly-sweep",
  status,
  attemptCount: 1,
  createdAt: new Date(Date.now() - ageH * HOUR).toISOString(),
  ...extra,
});

test("weekly-sweep completed 6 days ago is healthy, using the project's own key", async () => {
  const r = await runDeadman([run(144)], sweepArgs, sweepEnv);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen[0].auth, "Bearer tr_prod_rff");
});

test("weekly-sweep last completed 9 days ago alerts", async () => {
  const r = await runDeadman([run(216)], sweepArgs, sweepEnv);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /weekly-sweep.*last completed/);
});

test("a stranded-image deploy (weekly-sweep queued, 0 attempts) alerts", async () => {
  const stuck = run(2, "QUEUED", { attemptCount: 0 });
  const r = await runDeadman([run(144), stuck], sweepArgs, sweepEnv);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /stuck without ever starting/);
});

test("missing project key is an alert, not silence", async () => {
  const r = await runDeadman([], sweepArgs, {});
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /TRIGGER_SECRET_KEY_RSS_FEED_FACTORY is not set/);
});

test("a window shorter than the threshold is rejected", async () => {
  const r = await runDeadman([], ["--task=weekly-sweep", "--max-age-hours=200"], sweepEnv);
  assert.equal(r.code, 2, r.out);
});
