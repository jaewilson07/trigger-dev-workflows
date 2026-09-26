/**
 * Read a build-time-synced secret from `process.env` and fail loudly (not
 * with `undefined` silently threaded through) if it's absent.
 *
 * Split out of `tasks/assistant/daily-standup.ts` (2026-09-26) so this tiny,
 * dependency-free helper can be unit-tested directly — `daily-standup.ts`
 * itself pulls in `@datacrew/trigger-shared` and `@trigger.dev/sdk`, and
 * `@datacrew/trigger-shared`'s package.json points `main` straight at
 * `./src/index.ts` (no build step), which plain `node --test` (no ts-node/
 * tsx loader) cannot resolve on its own — a pre-existing gap in this repo's
 * test tooling (nothing in any project's `test` script currently imports
 * that package), not something to fix as a side effect of this change.
 *
 * See `trigger.config.ts`'s `SYNCED_SECRETS` comment for what "build-time
 * synced" means here, and `daily-standup.ts`'s own comment on why
 * `JAEWILSON07_GH_PAT` moved from a runtime `getSecret()` call to this.
 */
export function requireSyncedEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name} — expected it baked into this run's env by trigger.config.ts's ` +
        `SYNCED_SECRETS build-time sync. Check it's still in that allowlist and still ` +
        `present in Infisical (recursive lookup from "/"), then redeploy.`
    );
  }
  return value;
}
