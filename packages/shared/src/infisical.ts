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
 *
 * Memoized at module scope, keyed by the full credential pair: a task or
 * deploy that calls `getSecret()` more than once (or both `getSecret()` and
 * `syncEnvVars()` in the same process) reuses the same login instead of
 * re-authenticating with Infisical on every call. Keyed on clientId+
 * clientSecret together, not just clientId, so a secret rotation within the
 * same warm process still gets a fresh client rather than silently reusing
 * one authenticated under the old secret.
 */
let cachedClient: { key: string; client: Promise<InfisicalSDK> } | null = null;

function credentialsKey(credentials: InfisicalCredentials): string {
  return `${credentials.clientId}:${credentials.clientSecret}`;
}

function createAuthenticatedClient(credentials: InfisicalCredentials): Promise<InfisicalSDK> {
  const key = credentialsKey(credentials);
  if (cachedClient && cachedClient.key === key) {
    return cachedClient.client;
  }

  const clientPromise = (async () => {
    const client = new InfisicalSDK({
      siteUrl: process.env.INFISICAL_API_URL ?? "https://infisical.datacrew.space",
    });

    await client.auth().universalAuth.login({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });

    return client;
  })();

  cachedClient = { key, client: clientPromise };
  // Don't leave a rejected promise cached — a transient auth failure would
  // otherwise poison every subsequent call in the same process forever.
  clientPromise.catch(() => {
    if (cachedClient?.client === clientPromise) {
      cachedClient = null;
    }
  });
  return clientPromise;
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

    // ctx.environment is trigger.dev's env slug (prod/staging/dev), which
    // happens to match Infisical's. Overridable in case they diverge — kept
    // in its own variable so the error message below reports what was
    // actually queried, not always ctx.environment regardless of override.
    const environment = process.env.INFISICAL_ENVIRONMENT ?? ctx.environment;

    const { secrets } = await client.secrets().listSecrets({
      environment,
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
          `(env ${environment}). Check the name, and that the machine ` +
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
  /**
   * Whether to also search subfolders of `path`. Defaults to `true` (the
   * original behavior, needed for e.g. `/datacrew` where the target secret
   * may live one level down). Set `false` when the secret is known to live
   * directly at `path` — a recursive listSecrets from a broad path like `/`
   * returns every secret in every app's folder org-wide just to find one
   * key (~277 secrets as of 2026-08), which is unnecessary exposure/latency
   * for a lookup that doesn't need it.
   */
  recursive?: boolean;
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
  const recursive = opts.recursive ?? true;

  const { secrets } = await client.secrets().listSecrets({
    environment,
    projectId,
    secretPath: path,
    recursive,
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

export type SetSecretOptions = {
  /** Infisical folder to write under. Defaults to `/datacrew`. */
  path?: string;
  /** Infisical environment slug. Defaults to `INFISICAL_ENVIRONMENT` env var, then `"prod"`. */
  environment?: string;
  /** Infisical project/workspace id. Defaults to `INFISICAL_PROJECT_ID` env var, then the shared org project. */
  projectId?: string;
};

/**
 * Runtime write: upserts a single secret value, for tasks that need durable
 * state across runs of an ephemeral container (originally: `domo-docs-report`'s
 * SHA-cache gate — there's no `actions/cache` equivalent here, and Infisical is
 * already the one thing every task in this repo authenticates to and trusts).
 *
 * Not a general-purpose KV store: this reuses the credential store because it's
 * the durable thing already wired up, not because state belongs there
 * philosophically. Keep values here small and few.
 *
 * Tries `updateSecret` first (the common case once a value exists), and falls
 * back to `createSecret` only on the very first write. Infisical's SDK doesn't
 * expose a distinct "not found" error type over "any other failure" here, so a
 * genuine auth/network error will also fail the `createSecret` fallback and
 * surface as one combined error rather than being silently swallowed.
 */
export async function setSecret(key: string, value: string, opts: SetSecretOptions = {}): Promise<void> {
  const credentials = requireCredentials();
  const client = await createAuthenticatedClient(credentials);

  const path = opts.path ?? DEFAULT_SECRET_PATH;
  const environment = opts.environment ?? process.env.INFISICAL_ENVIRONMENT ?? DEFAULT_ENVIRONMENT;
  const projectId = opts.projectId ?? process.env.INFISICAL_PROJECT_ID ?? DEFAULT_PROJECT_ID;

  try {
    await client
      .secrets()
      .updateSecret(key, { environment, projectId, secretPath: path, secretValue: value });
    return;
  } catch (updateError) {
    try {
      await client
        .secrets()
        .createSecret(key, { environment, projectId, secretPath: path, secretValue: value });
      return;
    } catch (createError) {
      throw new Error(
        `setSecret: failed to write ${key} to Infisical ${path} (env ${environment}) — ` +
          `update: ${updateError instanceof Error ? updateError.message : String(updateError)}; ` +
          `create: ${createError instanceof Error ? createError.message : String(createError)}`
      );
    }
  }
}
