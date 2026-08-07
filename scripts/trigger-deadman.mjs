#!/usr/bin/env node
/**
 * External dead-man's switch for the self-hosted Trigger.dev instance.
 *
 * WHY THIS LIVES OUTSIDE TRIGGER.DEV. The existing watchdog project
 * (`watchdog/`) posts infra health to Slack — but it runs *on* Trigger.dev, so
 * an instance that cannot start containers silences its own alarm. That is
 * exactly what happened on 2026-08-06: the supervisor could not pull the
 * deployed image, every run sat QUEUED forever, and nothing said a word for
 * ~24h. A monitor inside the system it monitors reports "healthy" or reports
 * nothing; it never reports "I am down."
 *
 * So this is a plain script. Run it from cron/systemd on a host that is NOT
 * the Trigger.dev worker — it needs nothing but network access and the API key.
 *
 * It checks two things, because the 2026-08-06 failure was invisible to the
 * obvious one:
 *
 *   1. FRESHNESS — has `--task` completed within `--max-age-hours`? Catches
 *      "the daily never ran", whatever the cause.
 *   2. STUCK RUNS — any run older than `--stuck-minutes` that has never
 *      reached attempt 1. This is the precise signature of the outage: the
 *      supervisor dequeues, fails to pull, and re-queues forever, so the run
 *      flips QUEUED <-> EXECUTING with attemptCount stuck at 0. It never
 *      FAILS, so no failure alert can ever fire for it.
 *
 * Exit codes: 0 healthy, 1 alert raised, 2 could not check (also alerts —
 * "I could not tell" must never look like "fine").
 */

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [[m[1], m[2]]] : [];
  })
);

const API = (process.env.TRIGGER_API_URL ?? "https://triggers.datacrew.space").replace(/\/+$/, "");
const KEY = process.env.TRIGGER_SECRET_KEY ?? "";
const SLACK_TOKEN = process.env.DATACREW_SLACK_BOT_TOKEN ?? "";
const SLACK_CHANNEL = process.env.TRIGGER_DEADMAN_SLACK_CHANNEL_ID ?? "C0AV0QJ0YMB";

const WATCH_TASK = args.task ?? "morning-brief";
const MAX_AGE_HOURS = Number(args["max-age-hours"] ?? 25);
const STUCK_MINUTES = Number(args["stuck-minutes"] ?? 20);
const DRY_RUN = "dry-run" in args;

async function postSlack(text) {
  if (DRY_RUN) {
    console.log("[dry-run] would post to Slack:\n" + text);
    return;
  }
  if (!SLACK_TOKEN) {
    console.error("DATACREW_SLACK_BOT_TOKEN not set — cannot alert. Printing instead:\n" + text);
    return;
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false }),
  });
  const body = await res.json();
  // Slack returns HTTP 200 with {ok:false} on failure — status alone is a lie.
  if (!body.ok) console.error(`Slack rejected the alert: ${body.error}`);
}

async function main() {
  if (!KEY) {
    await postSlack(":rotating_light: Trigger.dev dead-man's switch cannot run — TRIGGER_SECRET_KEY is not set.");
    process.exit(2);
  }

  let runs;
  try {
    const res = await fetch(`${API}/api/v1/runs?limit=100`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    runs = (await res.json()).data ?? [];
  } catch (err) {
    // Unreachable API is itself the alert — this is the case where staying
    // quiet would repeat the original failure.
    await postSlack(
      `:rotating_light: *Trigger.dev unreachable* — dead-man's switch could not query \`${API}\`.\n> ${err.message}`
    );
    process.exit(2);
  }

  const problems = [];
  const now = Date.now();

  // 1. Freshness
  const lastOk = runs
    .filter((r) => r.taskIdentifier === WATCH_TASK && r.status === "COMPLETED")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  if (!lastOk) {
    problems.push(`*${WATCH_TASK}* has no COMPLETED run in the last 100 runs.`);
  } else {
    const ageH = (now - new Date(lastOk.createdAt).getTime()) / 3_600_000;
    if (ageH > MAX_AGE_HOURS) {
      problems.push(
        `*${WATCH_TASK}* last completed *${ageH.toFixed(1)}h ago* (threshold ${MAX_AGE_HOURS}h).`
      );
    }
  }

  // 2. Stuck runs — never reached attempt 1. The signature of a supervisor
  //    that cannot pull the deployed image.
  const stuck = runs.filter((r) => {
    if (!["QUEUED", "EXECUTING"].includes(r.status)) return false;
    if ((r.attemptCount ?? 0) > 0) return false;
    return (now - new Date(r.createdAt).getTime()) / 60_000 > STUCK_MINUTES;
  });

  if (stuck.length > 0) {
    const list = stuck
      .slice(0, 5)
      .map((r) => `• \`${r.taskIdentifier}\` queued ${((now - new Date(r.createdAt)) / 60_000).toFixed(0)}m, 0 attempts`)
      .join("\n");
    problems.push(
      `*${stuck.length} run(s) stuck without ever starting* — usually the supervisor cannot pull the deployed image.\n${list}`
    );
  }

  if (problems.length === 0) {
    console.log(`OK — ${WATCH_TASK} fresh, no stuck runs.`);
    process.exit(0);
  }

  await postSlack(
    `:rotating_light: *Trigger.dev needs attention* (${API})\n\n${problems.join("\n\n")}\n\n` +
      `_Checked by the external dead-man's switch, which runs outside Trigger.dev on purpose._`
  );
  process.exit(1);
}

main();
