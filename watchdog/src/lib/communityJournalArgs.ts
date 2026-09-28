/**
 * Shared `uv run` argv-tail builder for `domoCommunityJournal.ts` and
 * `slackCommunityJournal.ts` — both clone-and-invoke `jaewilson07/datacrew`'s
 * `.agents/runbooks/daily-slack-updates/{domo,slack}-community-journal/
 * scripts/main.py`.
 *
 * **Bug this fixes:** both tasks used to unconditionally `getSecret("ANTHROPIC_API_KEY", ...)`
 * before ever invoking `main.py`. That secret has never existed in Infisical
 * (see `executive-assistant/trigger.config.ts`'s `SYNCED_SECRETS` comment and
 * `docs/project_notes/bugs.md`), so every non-dry-run cron tick threw
 * `Secret ANTHROPIC_API_KEY not found in Infisical /` before `main.py` ever
 * ran. This function stops threading that key through at all and instead
 * always passes `--synthesizer letta`, so `main.py` never falls back to its
 * own `auto` default (headless `claude -p`, which needs the claude CLI's
 * cached OAuth session on PATH inside this container — unverified, see
 * `_shared/scripts/llm_client.py`'s "Known gap"). `letta` calls bonker's
 * letta gateway in ephemeral mode, authenticated with the SAME
 * `DATACREW_API_TOKEN` this task already fetches for its own mdrag writes —
 * the "gateway credential" this house's `.agents/plans/
 * two-gateway-llm-convergence.md` (Phase 6) and `completion-gateway.ts`
 * both describe, not a caller-held Anthropic API key.
 */
export type CommunityJournalArgsOptions = {
  /** Absolute path to the cloned datacrew repo's main.py for this pipeline. */
  scriptPath: string;
  /** Trailing window size in days. */
  days: number;
  /** mdrag collection (`--group-id`). */
  groupId: string;
  /** Fixed "which scheduled tick is this" timestamp — `--as-of`. */
  asOfIso: string;
  /** What counts as "interesting" for this classification pass. Omit for main.py's own default. */
  interesting?: string;
  /** Skip mdrag writes (create_annotation/add_episode); still fetches + classifies + redacts. */
  dryRun: boolean;
};

export function buildCommunityJournalArgs(opts: CommunityJournalArgsOptions): string[] {
  return [
    opts.scriptPath,
    "--days",
    String(opts.days),
    "--group-id",
    opts.groupId,
    "--as-of",
    opts.asOfIso,
    ...(opts.interesting ? ["--interesting", opts.interesting] : []),
    // Always explicit — never let main.py fall back to its own `auto`
    // default. See this module's docstring.
    "--synthesizer",
    "letta",
    ...(opts.dryRun ? ["--dry-run"] : []),
  ];
}
