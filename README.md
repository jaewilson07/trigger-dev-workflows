# Trigger.dev Workflows

This repository hosts standalone Trigger.dev workflow projects.

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

## Local setup

- Copy each project's `.env.example` to `.env` in that project folder.
- Keep project refs and Trigger keys scoped per project.
