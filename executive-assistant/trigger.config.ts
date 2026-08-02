import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { InfisicalSDK } from "@infisical/sdk";

/**
 * Secrets this project pulls from Infisical at deploy time.
 *
 * An ALLOWLIST, not a passthrough. A recursive list from `/` returns ~277
 * secrets spanning every app in the org (/letta, /mdrag, /paperclip, /alix,
 * /claude-slack, ...), and syncing all of them would copy the whole org's
 * credentials into this one trigger.dev environment, where they would show up
 * on the Environment Variables page and outlive whatever needed them. Add a
 * name here when a task genuinely needs it.
 *
 * The names are folder-scoped and NOT interchangeable: LETTA_API_KEY (/letta)
 * is the Letta Cloud key, while /datacrew holds a different
 * DATACREW_LETTA_API_KEY and /mdrag a different PRIMITIVES_LETTA_API_KEY.
 */
const SYNCED_SECRETS = ["LETTA_API_KEY"];

/**
 * executive-assistant — trigger.dev v4 project config.
 *
 * Renamed from "Morning Briefing" (proj_noaaludkbpoorzosejyn on the
 * self-hosted instance at triggers.datacrew.space); the ref itself doesn't
 * change on rename. Set TRIGGER_PROJECT_REF in `.env` (see .env.example) —
 * read from env so nothing is committed.
 *
 * Verify with:
 *   docker exec trigger-postgres-1 psql -U postgres -d main \
 *     -tAc 'select "externalRef", name from "Project";'
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  // dirs is resolved relative to this config file. Tasks live alongside it
  // (./morning-brief.ts, ./email-digest.ts, ./tasks/*.ts, ./demo/*.ts), so
  // index the whole dir. lib/*.ts files are plain modules (no task()/
  // schedules.task() export), so the build silently skips them.
  //
  // CAUTION: this indexes compiled output too, and the indexer does NOT
  // respect .gitignore. A `dist/` here from a local `tsc --outDir` gets
  // imported at build time -- and a module with top-level await executes,
  // failing the deploy with whatever that code touched. `npm test` therefore
  // builds into $TMPDIR, not into the project. Keep it that way.
  dirs: ["."],
  maxDuration: 3600,
  build: {
    extensions: [
      syncEnvVars(async (ctx) => {
        // No machine identity (a local `trigger dev`, or a checkout without
        // homeserver/.env) is not an error — it just means nothing to sync.
        // Throwing here would fail a deploy on a credential it never needed.
        if (!process.env.INFISICAL_CLIENT_ID || !process.env.INFISICAL_CLIENT_SECRET) {
          return [];
        }

        // Self-hosted, so siteUrl is required — the SDK defaults to Infisical
        // Cloud. Direct HTTPS is correct; the CF-Access proxy on :8082 that
        // infra-bonker's skill doc describes is stale (verified 2026-08-01:
        // /api/status returns a plain 200, and no such unit exists on bonker).
        const client = new InfisicalSDK({
          siteUrl: process.env.INFISICAL_API_URL ?? "https://infisical.datacrew.space",
        });

        await client.auth().universalAuth.login({
          clientId: process.env.INFISICAL_CLIENT_ID,
          clientSecret: process.env.INFISICAL_CLIENT_SECRET,
        });

        const { secrets } = await client.secrets().listSecrets({
          // ctx.environment is trigger.dev's env slug (prod/staging/dev), which
          // happens to match Infisical's. Overridable in case they diverge.
          environment: process.env.INFISICAL_ENVIRONMENT ?? ctx.environment,
          projectId: process.env.INFISICAL_PROJECT_ID ?? "3fbb4296-d4e6-4c17-83ee-b852a57a5e50",
          // Recursive from root: secrets live in per-app TOP-LEVEL folders, not
          // under one parent, so scoping to a single folder silently finds
          // nothing for anything outside it. SYNCED_SECRETS is what actually
          // limits the blast radius.
          secretPath: process.env.INFISICAL_SECRET_PATH ?? "/",
          recursive: true,
          viewSecretValue: true,
        });

        const wanted = secrets.filter((s) => SYNCED_SECRETS.includes(s.secretKey));
        const missing = SYNCED_SECRETS.filter((name) => !wanted.some((s) => s.secretKey === name));
        if (missing.length > 0) {
          // Loud, not silent: a renamed or moved secret otherwise surfaces much
          // later as an auth failure inside a task, far from its cause.
          throw new Error(
            `syncEnvVars: ${missing.join(", ")} not found in Infisical ` +
              `(env ${ctx.environment}). Check the name, and that the machine ` +
              `identity can read the folder it lives in.`
          );
        }

        return wanted.map((secret) => ({
          name: secret.secretKey,
          // Values round-trip through Infisical with dotenv-style quotes
          // intact, and a quoted API key fails auth in a way that looks like a
          // bad credential rather than a formatting problem.
          value: secret.secretValue.trim().replace(/^['"]|['"]$/g, ""),
        }));
      }),
    ],
  },
});
