/**
 * Task id -> owning GitHub repo, for `failureAlertReport.ts`
 * (jaewilson07/trigger-dev-workflows#206, "Failure alerting").
 *
 * "Owner" = the repo whose code/config must change to fix a failure in that
 * task — decided from what the task actually clones/runs, not from which
 * project folder its `.ts` file happens to live in. Every task defaults to
 * `DEFAULT_OWNING_REPO` (this repo): most failures are the task harness's
 * own bug, and #206's own audit table shows every historical fix for
 * `daily-standup` (wrong repo cloned, no `--no-project`, no `gh` in image,
 * missing Infisical creds — #203/#204/#205) landed HERE, not in the repo it
 * clones. An override below is for the opposite case: a task whose entire
 * job is to operate on another repo's own content/config, so a failure
 * there usually means that repo needs to change.
 *
 * `getOwningRepo` is keyed by `${projectKey}:${taskId}` so the same task id
 * used in two projects (e.g. `deliver-notion`, in both `executive-assistant`
 * and `indb-blues` — see `failureRepoMap.test.ts`'s enumeration) can be
 * mapped independently, even though today both fall through to the default.
 *
 * ## Explicit overrides, and why
 *
 * - `crew-rag-domo-scrape` (watchdog) clones AND runs
 *   `hector-dcs/crew-rag-domo`'s own Python
 *   (`watchdog/src/trigger/crewRagDomoScrape.ts`'s `CREW_RAG_DOMO_REPO`) —
 *   its one historical failure (#206's table: "private package index never
 *   declared", 46 runs) was a `crew-rag-domo` bug, fixed in
 *   `hector-dcs/crew-rag-domo#15`, not in this harness.
 * - `domo-docs-report` / `domo-community-journal` / `slack-community-journal`
 *   (watchdog) each clone+push `jaewilson07/datacrew`
 *   (`DATACREW_REPO_URL` in each file) to publish generated content there —
 *   a push failure (branch protection, missing path, merge conflict against
 *   content someone else pushed) is that repo's config, not this harness's.
 *
 * ## Deliberately NOT overridden (default applies), and why
 *
 * - `daily-standup` (executive-assistant) clones both `simpleDiscordBot` AND
 *   `alix_discordbot`, but see the table above: every fix so far was to this
 *   task's own code. Revisit only if a *content* bug surfaces in one of the
 *   cloned repos specifically.
 * - `blues-drop-research` / `deliver-web` / `deliver-discord` (indb-blues)
 *   clone `indb_discordbot`/`cboti`, but have no failure history yet to
 *   attribute one way or the other — default until a real failure shows a
 *   repo-specific pattern.
 * - every `*-docs-ingest` vendor-docs task (watchdog) already has its own
 *   failure-reporting path straight to this repo
 *   (`watchdog/src/lib/vendorDocsIngest.ts`'s `withVendorDocsFailureReporting`,
 *   hardcoded to that module's own `FAILURE_ISSUE_REPO`). The default here
 *   agrees, and `failureAlertReport.ts` still covers these tasks too (that
 *   existing mechanism reports much earlier / on every single failure, not
 *   just on >=2 consecutive — the two are complementary, not a duplicate).
 */

export const DEFAULT_OWNING_REPO = "jaewilson07/trigger-dev-workflows";

/** The three projects `failureAlertReport.ts` watches. Keys match the
 * workspace directory names, which is also what `getTriggerSecretKey`
 * (`packages/shared/src/trigger-task.ts`) expects as `projectKeyName`. */
export const MONITORED_PROJECTS = [
  { key: "executive-assistant", ref: "proj_noaaludkbpoorzosejyn" },
  { key: "watchdog", ref: "proj_wxqgcxxcutibtcgxlzky" },
  { key: "indb-blues", ref: "proj_vbdokvsqejsehxoztzmm" },
] as const;

export type MonitoredProjectKey = (typeof MONITORED_PROJECTS)[number]["key"];

function overrideKey(projectKey: string, taskId: string): string {
  return `${projectKey}:${taskId}`;
}

const FAILURE_REPO_OVERRIDES: Record<string, string> = {
  [overrideKey("watchdog", "crew-rag-domo-scrape")]: "hector-dcs/crew-rag-domo",
  [overrideKey("watchdog", "domo-docs-report")]: "jaewilson07/datacrew",
  [overrideKey("watchdog", "domo-community-journal")]: "jaewilson07/datacrew",
  [overrideKey("watchdog", "slack-community-journal")]: "jaewilson07/datacrew",
};

/**
 * Resolve the owning repo for a `(project, taskId)` pair. Always returns a
 * non-empty `"owner/repo"` string — never throws, never returns undefined —
 * so a brand-new task with no override still gets a sane, safe destination
 * (this repo) instead of silently going unreported. See
 * `failureRepoMap.test.ts` for the enumeration that keeps this honest as
 * tasks are added.
 */
export function getOwningRepo(projectKey: string, taskId: string): string {
  return FAILURE_REPO_OVERRIDES[overrideKey(projectKey, taskId)] ?? DEFAULT_OWNING_REPO;
}

/** Exported for the coverage test only. */
export const _internal = { overrideKey, FAILURE_REPO_OVERRIDES };
