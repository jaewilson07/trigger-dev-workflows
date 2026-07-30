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
