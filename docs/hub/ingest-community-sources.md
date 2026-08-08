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

## Docs hub — done, live, but in `datacrew` — not this repo, not crew-rag-domo

Domo's actual documentation hub (`DomoApps/domo-documentation-hub` on
GitHub, their official docs source) is scraped and ingested by two
separate `datacrew` pipelines, neither of which is a Trigger.dev task:

- **`ingest-domo-docs.yml`** — daily cron on bonker
  (`0 9 * * *`, `infra-bonker/.agents/runbooks/ingest-domo-docs/ingest-domo-docs.sh`),
  not a GitHub Actions schedule — the workflow file itself is manual-dispatch
  only, because ingest has to reach mdrag's bonker-local API
  (`localhost:8017`), which a GitHub-hosted runner can't. SHA-cache gated
  (skips when upstream is unchanged); queues an ingest job against mdrag's
  own job API. Verified live: successful runs every day through 2026-08-08.
- **`generate-domo-recent-docs-report.yml`** — daily at 8am UTC, GitHub-hosted
  (the public repo needs no auth for change detection), generates a filtered
  markdown report of recent doc changes and feeds a Slack Canvas (see
  `datacrew`'s "Domo Docs Canvas Chron Job Runbook").

`datacrew/AGENTS.md`'s own CI Workflows table lists `ingest-domo-docs.yml`
as `schedule`-triggered, which is stale — worth fixing there, not repeated
here as if it were still accurate.

This is unrelated to the (now-removed) `crew-rag-domo` runbook that
originally prompted this doc: that one's `--source docs --docs-path` mode
was for an ad-hoc **local** directory, never actually worked (imported a
module that doesn't exist), and had no CI/cron wiring — a much smaller,
already-dead thing that happened to share the word "docs" with this real
pipeline. If you're looking for where Domo's documentation hub actually
gets ingested, it's the two `datacrew` workflows above, not anything in
`crew-rag-domo` or this repo.
