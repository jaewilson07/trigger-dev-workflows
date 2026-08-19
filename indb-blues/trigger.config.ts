import { defineConfig } from "@trigger.dev/sdk";
import { gitAndUv } from "@datacrew/trigger-shared";

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
 * `build.extensions: [gitAndUv()]` added by trigger-dev-workflows#98
 * (`blues-drop-research`/`deliver-discord` need `uv` on PATH at runtime to
 * clone+build `indb_discordbot`'s Python workspace, same as watchdog's
 * `crewRagDomoScrape.ts`). No `syncEnvVars` — every Infisical secret this
 * project's tasks need (`JAEWILSON07_GH_PAT`, `SPOTIFY_CLIENT_ID`,
 * `SPOTIFY_CLIENT_SECRET`, the Discord bot token) is fetched at RUNTIME via
 * `getSecret()`, same as watchdog's `crewRagDomoScrape.ts` and
 * `infraHealthReport.ts` — nothing here is a build-time secret.
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
  build: {
    extensions: [gitAndUv()],
  },
});
