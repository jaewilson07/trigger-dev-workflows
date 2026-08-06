# Workflow Observability Standard

This standard applies to Trigger tasks in this repo.

## Why

Workflows now include branching and recursion. Flat "step N" logs are not enough to debug production runs.

## Required logging shape

For each task file that defines a Trigger task (`task`, `schemaTask`, `schedules.task`):

1. Import `logger` from `@trigger.dev/sdk`.
2. Emit at least two logs in the task lifecycle:
- One start-ish message (`starting`, `begin`, `launch`, `running`).
- One terminal message (`completed`, `failed`, `done`, `error`, `finished`, `success`).
3. Prefer structured context objects as the second logger argument.

Example:

```ts
logger.info("starting pattern-hunter-pain-points", { businessInput });

// ...work...

logger.info("completed pattern-hunter-pain-points", {
  businessInput,
  nPainPoints: response.pain_points.length,
  nEvidenceSources: response.evidence_sources.length,
});
```

## Branch/loop observability guidance

For recursive or branching workflows:

1. Keep run metadata append-only where possible.
2. Emit explicit `skipped` states for declared-but-unneeded steps.
3. Do not silently overwrite sibling branch results.
4. Publish current in-flight step indicators for subscribers.

## Pre-commit enforcement

This repo ships a staged-file pre-commit linter:

- Command: `npm run check:trigger-logging`
- All files mode (migration): `npm run check:trigger-logging:all`
- Hook install (one-time per clone): `npm run hooks:install`

The linter checks only staged files by default, so legacy files are not immediately blocking.

## Temporary exceptions

A file can opt out with an explicit comment containing:

`trigger-log-lint: disable`

Use this only with a short justification comment nearby.
