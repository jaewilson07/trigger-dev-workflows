# Ingesting Domo community sources

Two source types, two very different states as of 2026-08-08.

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

## Docs hub — not built

There used to be a second half to this: `crew-rag-domo`'s
`.agents/runbooks/ingest-community-sources/` runbook also had a `--source docs`
mode meant to ingest a local documentation directory (`--docs-path`) into the
knowledge base. It never actually worked — it imported
`crew_rag_domo.docs_collector`, a module that was never built, and referenced
a pre-repo-split path layout (`datacrew/crew-rag-domo/...`) alongside the now
fully-retired `mdrag-vanillaforums` satellite package. It also had no CI/cron
wiring anywhere, unlike the forums half — nothing ever invoked it
automatically.

The runbook itself was removed (hector-dcs/crew-rag-domo#9) rather than
fixed, because there was nothing working to fix — a decision about
docs-hub ingestion (what it should even collect, and whether it's still
wanted) needs to happen before there's code worth writing. If you're picking
this up: start there, not with the old script.
