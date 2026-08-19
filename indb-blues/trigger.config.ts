import { defineConfig } from "@trigger.dev/sdk";

/**
 * indb-blues — trigger.dev v4 project config.
 *
 * Scaffolded by trigger-dev-workflows#97 to prove the plumbing (deploy +
 * live-trigger) for a brand-new project on the self-hosted instance, ahead
 * of #98-#101 which build indb-blues's real tasks on top of this shape.
 *
 * project ref: proj_vbdokvsqejsehxoztzmm ("indb-blues" on
 * https://triggers.datacrew.space, org datacrew-7d98) — created via the
 * PAT-authenticated `POST /api/v1/orgs/{org}/projects` route
 * (apps/webapp/app/routes/api.v1.orgs.$orgParam.projects.ts on the vendored
 * trigger.dev checkout), the same `createProject()` codepath the dashboard's
 * "New Project" form calls, so the generated per-environment keys are real,
 * not placeholders (see storm-research's historical
 * `tr_prod_test123`-style placeholder bug, trigger-dev-workflows#45, for
 * what "not real" looks like). Set TRIGGER_PROJECT_REF in `.env` (see
 * .env.example) — read from env so nothing is committed.
 *
 * No `build.extensions` yet, unlike watchdog (gitAndUv) or
 * executive-assistant (syncEnvVars): the only task here so far,
 * indb-blues-hello, needs neither a Python/uv workspace nor an Infisical
 * secret synced at build time. Add `syncEnvVars([...])` here (see
 * executive-assistant/trigger.config.ts for the pattern and its
 * "allowlist that throws on a missing name" gotcha) once a real task needs
 * a build-time secret; anything run-time-only can instead be set directly
 * on this project's dashboard environment, same as every non-synced
 * variable in watchdog and executive-assistant already is.
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
});
