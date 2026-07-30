# Trigger.dev Workflows

This repository hosts standalone Trigger.dev workflow projects.

## Projects

- watchdog: infrastructure health report workflow
- executive-assistant: Gmail triage, on-demand digest, Pattern Hunter, and
  Deep Researcher workflows (project "executive-assistant",
  `proj_noaaludkbpoorzosejyn` on the self-hosted instance — renamed from
  "Morning Briefing")

## Quick start

Run from this folder:

- `npm run dev:watchdog`
- `npm run deploy:watchdog`
- `npm run dev:executive-assistant`
- `npm run deploy:executive-assistant`

Each project has its own `.env.example` and `trigger.config.ts`.

## Local setup

- Copy each project's `.env.example` to `.env` in that project folder.
- Keep project refs and Trigger keys scoped per project.

## Self-hosted deploy gotcha: `APP_ORIGIN`/`LOGIN_ORIGIN`/`API_ORIGIN`

If `trigger deploy` fails at the build's indexer step with `Failed to fetch
environment variables: Connection error.`, the cause is almost certainly
**not** anything in this repo or your CLI flags/`.env` — it's the
self-hosted webapp's own advertised origin.

At deploy time the CLI asks the server what API URL to bake into the
deployed image (`TRIGGER_API_URL`, ends up as a build ARG and a runtime env
var). The server answers with its own configured `API_ORIGIN`. If that's
still `http://localhost:8030` (the compose default), every build fails: the
CLI tries to compensate by rewriting `localhost` → `http://host.docker.internal:8030`
(mapped via `--add-host` to the host's LAN IP), but the webapp's port is
deliberately published on `127.0.0.1` only (closing a real LAN-bypass
vulnerability — see infra-bonker's zero-click sign-in runbook) — so that
LAN IP never has anything listening. **No client-side fix works**: `--api-url`,
`.env`'s `TRIGGER_API_URL`, even editing the CLI's own login profile —
verified, none of them change the build-arg. Only the server's own
`API_ORIGIN` (and `APP_ORIGIN`/`LOGIN_ORIGIN` alongside it, for consistency)
matters.

**Fix:** on the host running the self-hosted webapp, set all three to the
real public hostname in the stack's `.env` (`hosting/docker/.env` for the
trigger.dev fork on bonker), then recreate just the webapp service:

```bash
sed -i \
  -e 's|^APP_ORIGIN=.*|APP_ORIGIN=https://triggers.datacrew.space|' \
  -e 's|^LOGIN_ORIGIN=.*|LOGIN_ORIGIN=https://triggers.datacrew.space|' \
  -e 's|^API_ORIGIN=.*|API_ORIGIN=https://triggers.datacrew.space|' \
  hosting/docker/.env
docker compose --env-file .env -f webapp/docker-compose.yml -f worker/docker-compose.yml up -d webapp
```

Once fixed, a completely standard `trigger login` + `trigger deploy` against
the public hostname works — no `--api-url` override, no custom buildx
builder/network needed. Verified end-to-end 2026-07-30: `fetch-emails`
triggered over the public API returned real Gmail data on the first deploy
after this fix.
