# Trigger.dev Tasks Workspace

This folder now contains separate Trigger.dev projects.

## Projects

- watchdog: infrastructure health report workflow
- email-digest: Gmail summary workflow

## Quick start

Run from this folder:

- `npm run dev:watchdog`
- `npm run deploy:watchdog`
- `npm run dev:email-digest`
- `npm run deploy:email-digest`

Each project has its own `.env.example` and `trigger.config.ts`.

## Legacy backup

The previous mixed single-project layout is preserved under `watchdog-legacy/root-project`.
