# Ingesting Domo community sources

Two source types, both live — in two different repos, on two different
mechanisms.

## Forums — done, live in production

`crew-rag-domo-scrape` (`watchdog` project, cron `0 6 * * *`) clones
`hector-dcs/crew-rag-domo` + `jaewilson07/mdrag`, runs
`uv run crew-scrape-domo sync --months-back N` against the live VanillaForums
API, and commits/pushes the result to `crew-rag-domo`'s `EXPORTS/domo/community/`.
This replaced `crew-rag-domo`'s own `daily-scrape.yaml` GitHub Action
(hector-dcs/crew-rag-domo#7) — see `docs/watchdog-rework.md` for how the task
itself is structured, and `.agents/skills/deploy-trigger-tasks/SKILL.md` in
`simpleDiscordBot` for how it's deployed and debugged.

Verified live 2026-08-08: real commit
[`4073100`](https://github.com/hector-dcs/crew-rag-domo/commit/40731003f4d8d82f1b64fa8d49ba0cb2eed9ed20),
real scraped threads.

## Docs hub — a `watchdog` Trigger.dev task, via `vendor-docs-sync`

Domo's actual documentation hub (`DomoApps/domo-documentation-hub` on
GitHub, their official docs source) is synced by
[`domoDocsIngest.ts`](../../watchdog/src/trigger/vendor-docs/domoDocsIngest.ts)
(`watchdog` project, `domo-docs-ingest`, cron `0 9 * * *`), one of the four
vendor-doc-sync tasks consolidated under
jaewilson07/trigger-dev-workflows#128 — see that issue for the full design
(the other three: Letta docs, Trigger.dev agent skills, Claude Code docs).

The task mirrors `DomoApps/domo-documentation-hub`'s `s/article` subtree into
`jaewilson07/vendor-docs-sync`'s `domo-docs/` subfolder (committing/pushing
only on a real content diff), then ingests that subfolder — never the
upstream repo directly — via `POST /ingest/git-repo`, scoped to its existing
`repo_domoapps-domo-documentation-hub` mdrag collection with an explicit
`collection_id` (mdrag's auto-derived collection name only accounts for
`owner/repo`, not the subpath, so an unscoped call here would merge all four
vendor-docs-sync sources into one collection). Shared mirror/ingest logic
lives in `watchdog/src/lib/vendorDocsMirror*.ts` and
`watchdog/src/lib/vendorDocsIngest.ts`.

This replaces `ingest-domo-docs.yml`'s prior bonker cron shape
(`infra-bonker/.agents/runbooks/ingest-domo-docs/ingest-domo-docs.sh`,
migrated to Trigger.dev under #31/#34/#36, then onto the shared
vendor-docs-sync helper under #128) — no bonker-local `localhost:8017`
dependency, no `X-Internal-Secret`, `DATACREW_API_TOKEN` Bearer auth
throughout.

The Slack Canvas digest of recent doc changes
([`domoDocsReport.ts`](../../watchdog/src/trigger/domoDocsReport.ts),
`domo-docs-report`, daily at 8am UTC) is a separate `watchdog` task, also
already migrated off `datacrew`'s `generate-domo-recent-docs-report.yml`
GitHub Action — it clones `domo-documentation-hub` independently for its own
diff/report purposes and is out of scope for #128 (sync-into-mdrag only, no
report/digest changes — see that issue's Out of Scope section).

This is unrelated to the (now-removed) `crew-rag-domo` runbook that
originally prompted this doc: that one's `--source docs --docs-path` mode
was for an ad-hoc **local** directory, never actually worked (imported a
module that doesn't exist), and had no CI/cron wiring — a much smaller,
already-dead thing that happened to share the word "docs" with this real
pipeline. If you're looking for where Domo's documentation hub actually
gets ingested, it's `domoDocsIngest.ts` above — a `watchdog` Trigger.dev
task in this repo — not anything in `crew-rag-domo` or `datacrew`.
