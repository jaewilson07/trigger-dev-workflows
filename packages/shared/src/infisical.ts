import { InfisicalSDK } from "@infisical/sdk";
import { syncEnvVars as buildSyncEnvVars } from "@trigger.dev/build/extensions/core";

/**
 * Shared Infisical integration for every trigger.dev workspace project
 * against our self-hosted instance.
 *
 * Two call shapes, one auth/client implementation:
 *   - `syncEnvVars(allowlist)` — a build-time extension (bakes an allowlisted
 *     set of secrets into the deploy). Originally lived inline in
 *     executive-assistant/trigger.config.ts.
 *   - `getSecret(key, opts)` — a runtime lookup (fetches a single secret when
 *     a task actually needs it, nothing baked in). Originally lived inline in
 *     watchdog/src/trigger/infraHealthReport.ts as
 *     fetchInfisicalAccessToken/fetchInfisicalSecret.
 *
 * Both authenticate the same way (universal-auth, INFISICAL_CLIENT_ID/
 * INFISICAL_CLIENT_SECRET) against the same self-hosted API, so that part is
 * written once here and shared.
 */

const DEFAULT_PROJECT_ID = "3fbb4296-d4e6-4c17-83ee-b852a57a5e50";
const DEFAULT_SECRET_PATH = "/datacrew";
const DEFAULT_ENVIRONMENT = "prod";

type InfisicalCredentials = {
  clientId: string;
  clientSecret: string;
};

function readCredentials(): InfisicalCredentials | null {
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

function requireCredentials(): InfisicalCredentials {
  const credentials = readCredentials();
  if (!credentials) {
    throw new Error(
      "Missing INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET — required to look up secrets from Infisical."
    );
  }
  return credentials;
}

/**
 * Self-hosted, so siteUrl is required — the SDK defaults to Infisical Cloud.
 * Direct HTTPS is correct; the CF-Access proxy on :8082 that infra-bonker's
 * skill doc describes is stale (verified 2026-08-01: /api/status returns a
 * plain 200, and no such unit exists on bonker).
 */
async function createAuthenticatedClient(credentials: InfisicalCredentials): Promise<InfisicalSDK> {
  const client = new InfisicalSDK({
    siteUrl: process.env.INFISICAL_API_URL ?? "https://infisical.datacrew.space",
  });

  await client.auth().universalAuth.login({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });

  return client;
}

/**
 * Values round-trip through Infisical with dotenv-style quotes intact, and a
 * quoted API key fails auth in a way that looks like a bad credential rather
 * than a formatting problem.
 */
function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

/**
 * Build-time extension: syncs an ALLOWLIST of secrets into the deploy.
 *
 * A recursive list from `/` returns every secret spanning every app in the
 * org (/letta, /mdrag, /paperclip, /alix, /claude-slack, ...), and syncing
 * all of them would copy the whole org's credentials into one trigger.dev
 * environment, where they'd show up on the Environment Variables page and
 * outlive whatever needed them. `allowlist` is what actually limits the
 * blast radius — callers pass only the names their tasks genuinely need.
 */
export function syncEnvVars(allowlist: string[]) {
  return buildSyncEnvVars(async (ctx) => {
    // Nothing to do — skip the auth round-trip and listSecrets call entirely
    // rather than making a pointless network request on every deploy.
    if (allowlist.length === 0) {
      return [];
    }

    // No machine identity (a local `trigger dev`, or a checkout without
    // homeserver/.env) is not an error — it just means nothing to sync.
    // Throwing here would fail a deploy on a credential it never needed.
    const credentials = readCredentials();
    if (!credentials) {
      return [];
    }

    const client = await createAuthenticatedClient(credentials);

    const { secrets } = await client.secrets().listSecrets({
      // ctx.environment is trigger.dev's env slug (prod/staging/dev), which
      // happens to match Infisical's. Overridable in case they diverge.
      environment: process.env.INFISICAL_ENVIRONMENT ?? ctx.environment,
      projectId: process.env.INFISICAL_PROJECT_ID ?? DEFAULT_PROJECT_ID,
      // Recursive from root: secrets live in per-app TOP-LEVEL folders, not
      // under one parent, so scoping to a single folder silently finds
      // nothing for anything outside it. `allowlist` is what actually
      // limits the blast radius.
      secretPath: process.env.INFISICAL_SECRET_PATH ?? "/",
      recursive: true,
      viewSecretValue: true,
    });

    const wanted = secrets.filter((secret) => allowlist.includes(secret.secretKey));
    const missing = allowlist.filter((name) => !wanted.some((secret) => secret.secretKey === name));
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
      value: stripQuotes(secret.secretValue),
    }));
  });
}

export type GetSecretOptions = {
  /** Infisical folder to look under. Defaults to `/datacrew`. */
  path?: string;
  /** Infisical environment slug. Defaults to `INFISICAL_ENVIRONMENT` env var, then `"prod"`. */
  environment?: string;
  /** Infisical project/workspace id. Defaults to `INFISICAL_PROJECT_ID` env var, then the shared org project. */
  projectId?: string;
};

/**
 * Runtime lookup: fetches a single secret by key when a task actually needs
 * it, rather than baking it into the deploy. Unlike `syncEnvVars`, missing
 * credentials here are a hard failure — a task that calls this genuinely
 * needs the secret to do its job.
 *
 * `path` defaults to `/datacrew` (the original call site, watchdog's Slack
 * bot token), but is overridable — other folders (e.g. `/mdrag`) may hold
 * secrets future consumers need.
 */
export async function getSecret(key: string, opts: GetSecretOptions = {}): Promise<string> {
  const credentials = requireCredentials();
  const client = await createAuthenticatedClient(credentials);

  const path = opts.path ?? DEFAULT_SECRET_PATH;
  const environment = opts.environment ?? process.env.INFISICAL_ENVIRONMENT ?? DEFAULT_ENVIRONMENT;
  const projectId = opts.projectId ?? process.env.INFISICAL_PROJECT_ID ?? DEFAULT_PROJECT_ID;

  const { secrets } = await client.secrets().listSecrets({
    environment,
    projectId,
    secretPath: path,
    recursive: true,
    viewSecretValue: true,
  });

  const value = secrets.find((secret) => secret.secretKey === key)?.secretValue;
  // Not a falsy check on purpose — a secret that's legitimately an empty
  // string is a real value, not a miss. Only undefined means "not found".
  if (value === undefined) {
    throw new Error(`Secret ${key} not found in Infisical ${path}`);
  }

  return stripQuotes(value);
}
