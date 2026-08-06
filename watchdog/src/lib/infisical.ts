/**
 * Infisical secret fetch — now a FALLBACK, not the primary path.
 *
 * These two functions used to live inline in `infraHealthReport.ts` and ran on
 * every report, because the Slack token was only ever read from Infisical. They
 * are kept (rather than deleted in favour of the `syncEnvVars` build extension
 * the other two projects use, which the composition audit suggested) for one
 * reason: an existing watchdog deployment has no `DATACREW_SLACK_BOT_TOKEN` env
 * var set, so deleting this path would break the live schedule on the next
 * deploy. `infra-deliver-slack` now checks the environment FIRST and only falls
 * back here, so the ordinary path costs zero extra round trips and an
 * environment that sets the variable never touches Infisical at all.
 *
 * Adopting `syncEnvVars` is the right end state and is a one-line config change
 * once the env var is set on the project — see `docs/watchdog-rework.md`.
 */

const INFISICAL_PROJECT_ID = "3fbb4296-d4e6-4c17-83ee-b852a57a5e50";
const INFISICAL_SECRET_PATH = "/datacrew";
const INFISICAL_ENVIRONMENT = "prod";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function baseUrl(): string {
  return (process.env.INFISICAL_API_URL || "https://infisical.datacrew.space").replace(/\/$/, "");
}

async function fetchInfisicalAccessToken(): Promise<string> {
  const clientId = requireEnv("INFISICAL_CLIENT_ID");
  const clientSecret = requireEnv("INFISICAL_CLIENT_SECRET");

  const res = await fetch(`${baseUrl()}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Infisical auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) {
    throw new Error("Infisical auth response missing accessToken");
  }
  return data.accessToken;
}

export async function fetchInfisicalSecret(secretKey: string): Promise<string> {
  const token = await fetchInfisicalAccessToken();
  const url = new URL(`${baseUrl()}/api/v3/secrets/raw`);
  url.searchParams.set("workspaceId", INFISICAL_PROJECT_ID);
  url.searchParams.set("environment", INFISICAL_ENVIRONMENT);
  url.searchParams.set("secretPath", INFISICAL_SECRET_PATH);
  url.searchParams.set("recursive", "true");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Infisical fetch failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { secrets?: Array<{ secretKey?: string; secretValue?: string }> };
  const secret = data.secrets?.find((item) => item.secretKey === secretKey)?.secretValue?.trim();
  if (!secret) {
    throw new Error(`Secret ${secretKey} not found in Infisical ${INFISICAL_SECRET_PATH}`);
  }
  return secret.replace(/^['"]|['"]$/g, "");
}
