import { task, logger } from "@trigger.dev/sdk";

export type LogActivityPayload = {
  date: string;
  emailCount: number;
  topicCount: number;
  slackTs: string | null;
  pipelineDurationMs: number;
};

export type ActivityLogEntry = LogActivityPayload & { logged_at: string };

/** Pure so the shape is testable without a filesystem or a Trigger.dev
 * runtime — see `log-activity.test.ts`. */
export function buildActivityEntry(payload: LogActivityPayload): ActivityLogEntry {
  return {
    ...payload,
    logged_at: new Date().toISOString(),
  };
}

/**
 * Records one morning-brief run's activity summary.
 *
 * Used to `appendFile` a JSONL line to `../data/brief-activity.jsonl` (a
 * path relative to `process.cwd()`, inherited unchanged from this task's
 * origin — the-ai-cfo's Trigger.dev pipeline (`feat: add executive-assistant
 * project`, 2026-07-30), which itself inherited it from a persistent-host
 * script where a relative `../data` directory next to the script made
 * sense). Every `morning-brief` run threw `EACCES: permission denied,
 * mkdir '../data'` here (non-fatal to the brief itself — `morning-brief.ts`
 * calls this via fire-and-forget `.trigger()`, not `.triggerAndWait()` — but
 * it failed as its own TaskRun daily, diagnosed 2026-09-26):
 *
 *   1. Trigger.dev tasks run in a fresh, ephemeral container per invocation
 *      (no shared, writable volume across runs — same reason
 *      `mdrag-api-worker-separate-containers-tempfile` is a documented
 *      gotcha elsewhere in this org). `../data` resolves outside whatever
 *      directory the container actually grants write access to, hence
 *      EACCES on `mkdir`.
 *   2. Even granting the mkdir would only silence the crash, not restore
 *      the original intent: a file written inside one run's container does
 *      not survive to the next run, so an ever-growing local JSONL history
 *      was never actually achievable in this execution model regardless of
 *      the exact path.
 *   3. Nothing in this repo reads `brief-activity.jsonl` back (verified by
 *      a repo-wide grep 2026-09-26) — it was write-only telemetry.
 *
 * The fix drops the local file: `logger.info` below already gets each
 * entry into Trigger.dev's own per-run log/metadata store, which — unlike
 * the container's local disk — genuinely persists across runs and is
 * queryable per run via the dashboard/API. If a cross-run queryable history
 * is needed later (e.g. a weekly rollup), route it through one of this
 * project's existing durable sinks (mdrag via `report-mdrag.ts`'s pattern,
 * or Notion) rather than local disk — but that is new functionality nobody
 * has asked for yet, not a requirement of this fix.
 */
export const logActivity = task({
  id: "log-activity",
  run: async (payload: LogActivityPayload): Promise<void> => {
    logger.info("starting log-activity");

    const entry = buildActivityEntry(payload);
    logger.info("Logged morning brief activity", entry);

    logger.info("completed log-activity");
  },
});
