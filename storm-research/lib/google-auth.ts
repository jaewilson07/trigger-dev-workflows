import { google } from "googleapis";

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL ?? "https://api.datacrew.space";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/**
 * Shape cboti's GoogleAuthFactory persists (auth_factory.py `_creds_to_json`).
 * client_id/client_secret live HERE, not in a separate GDOC_CLIENT env --
 * verified against a real stored token on 2026-07-30 (keys: access_token,
 * client_id, client_secret, refresh_token, scopes, token_uri; no expiry
 * field at all).
 */
type StoredGoogleToken = {
  access_token: string;
  refresh_token: string;
  token_uri?: string;
  client_id: string;
  client_secret: string;
  scopes?: string[];
};

export class NoGoogleTokenError extends Error {
  constructor(public readonly ownerEmail: string) {
    super(`No Gmail token stored for owner_email: ${ownerEmail}`);
    this.name = "NoGoogleTokenError";
  }
}

/**
 * A verbatim copy of `executive-assistant/lib/google-auth.ts` — see
 * `lib/google-docs.ts`'s module docstring for why the two projects copy rather
 * than import.
 *
 * `ownerEmail` must be the canonical, lowercased primary email (ADR-030/044)
 * -- NOT a `slack:`-prefixed platform identifier. The auth-service now keys
 * `google_tokens` rows by `owner_email` and rejects anything that looks like
 * a platform-prefixed id (infra-bonker#409). Resolving a Slack user ID to a
 * canonical email is a separate, currently-blocked effort (infra-bonker#396)
 * -- this module does not do that resolution, it only forwards whatever
 * identifier its caller already has.
 */
async function fetchStoredToken(ownerEmail: string): Promise<StoredGoogleToken> {
  const res = await fetch(
    `${AUTH_SERVICE_URL}/auth/google/token/${encodeURIComponent(ownerEmail)}`,
    { headers: { "X-Token-API-Key": requireEnv("GOOGLE_TOKEN_API_KEY") } },
  );
  if (res.status === 404) {
    throw new NoGoogleTokenError(ownerEmail);
  }
  if (!res.ok) {
    throw new Error(`auth-service token lookup failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token_json: string };
  return JSON.parse(body.token_json) as StoredGoogleToken;
}

async function persistToken(ownerEmail: string, token: StoredGoogleToken): Promise<void> {
  const res = await fetch(
    `${AUTH_SERVICE_URL}/auth/google/token/${encodeURIComponent(ownerEmail)}`,
    {
      method: "PUT",
      headers: {
        "X-Token-API-Key": requireEnv("GOOGLE_TOKEN_API_KEY"),
        "Content-Type": "application/json",
      },
      // No `platform` field: the auth-service no longer uses it for keying,
      // and hardcoding "slack" here was misleading -- this write-back can be
      // triggered from any surface that reached this task.
      body: JSON.stringify({ token_json: JSON.stringify(token) }),
    },
  );
  if (!res.ok) {
    throw new Error(`auth-service token write-back failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Returns an authenticated OAuth2 client for Gmail with a freshly refreshed
 * access token.
 *
 * The stored token carries no expiry, so cboti's Python path (which only
 * refreshes when `creds.expired` is true) never refreshes it either --
 * that's the actual cause of the "Gmail list error: 401" seen in production
 * on 2026-07-27. Refreshing unconditionally on every call sidesteps needing
 * an expiry to trust, and is cheap for a scheduled/on-demand task.
 *
 * Node's `Credentials` type has no client_id/client_secret fields (unlike
 * Python's), so they must go on the OAuth2 constructor -- pulling them from
 * the STORED token (not GDOC_CLIENT) matches what cboti's own refresh path
 * actually reads.
 */
export async function getFreshGmailAuth(ownerEmail: string) {
  const stored = await fetchStoredToken(ownerEmail);
  const client = new google.auth.OAuth2(stored.client_id, stored.client_secret);
  client.setCredentials({ refresh_token: stored.refresh_token });

  const { credentials } = await client.refreshAccessToken();
  client.setCredentials(credentials);

  // Google rarely rotates the refresh_token on refresh; persist it if it did,
  // otherwise keep the one we already have.
  await persistToken(ownerEmail, {
    ...stored,
    access_token: credentials.access_token!,
    refresh_token: credentials.refresh_token ?? stored.refresh_token,
  });

  return client;
}
