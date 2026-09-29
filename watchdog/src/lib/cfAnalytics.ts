/**
 * Cloudflare Analytics quota alert — jaewilson07/datacrew-site#241.
 *
 * Reads today's Workers/Pages Functions invocations for the account and the
 * busiest client IPs on the datacrew.space zone over the last hour. Pure
 * builders/parsers plus an injectable `fetch`, so it is tested without network.
 *
 * Needs a DEDICATED token, `CF_ANALYTICS_TOKEN` (Account Analytics:Read + Zone
 * Analytics:Read for datacrew.space). The existing CF token lacks Analytics:Read
 * (GraphQL/REST returns code 10000), so this never falls back to it.
 */

export const QUOTA_THRESHOLDS = [60_000, 80_000] as const;
export const DAILY_FREE_CAP = 100_000;
export const IP_HOURLY_LIMIT = 5_000;
export const CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

export const REQUIRED_SCOPES = ["Account > Account Analytics > Read", "Zone > Analytics > Read (zone: datacrew.space)"];

export class MissingAnalyticsTokenError extends Error {
  constructor() {
    super(
      "CF_ANALYTICS_TOKEN is missing. Create a Cloudflare API token with " +
        `${REQUIRED_SCOPES.join(" and ")}, and store it as CF_ANALYTICS_TOKEN in Infisical. ` +
        "The existing CF token lacks Analytics:Read (error 10000) and must not be reused.",
    );
    this.name = "MissingAnalyticsTokenError";
  }
}

export class CloudflareGraphqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareGraphqlError";
  }
}

export const INVOCATIONS_QUERY = `query Invocations($account: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
      }
    }
  }
}`;

export const CLIENT_IP_QUERY = `query TopClients($zone: String!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      httpRequestsAdaptiveGroups(limit: 1000, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end }) {
        count
        dimensions { clientIP userAgent }
      }
    }
  }
}`;

export type GraphqlFetch = (query: string, variables: Record<string, string>) => Promise<unknown>;

export function makeGraphqlFetch(token: string, fetchImpl: typeof fetch = fetch): GraphqlFetch {
  return async (query, variables) => {
    const res = await fetchImpl(CF_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new CloudflareGraphqlError(`Cloudflare GraphQL HTTP ${res.status}`);
    const data = (await res.json()) as { data?: unknown; errors?: Array<{ message?: string; extensions?: { code?: string } }> | null };
    if (data.errors && data.errors.length > 0) {
      const msg = data.errors.map((e) => e.message ?? "unknown").join("; ");
      throw new CloudflareGraphqlError(`Cloudflare GraphQL error: ${msg} (does CF_ANALYTICS_TOKEN have Analytics:Read?)`);
    }
    return data.data;
  };
}

export async function fetchInvocationsToday(gql: GraphqlFetch, accountId: string, now: Date): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const data = (await gql(INVOCATIONS_QUERY, { account: accountId, start: start.toISOString(), end: now.toISOString() })) as {
    viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }> }> };
  };
  const account = data?.viewer?.accounts?.[0];
  if (!account) throw new CloudflareGraphqlError(`no account data returned for ${accountId} (wrong CF_ACCOUNT_ID or token scope)`);
  return (account.workersInvocationsAdaptive ?? []).reduce((sum, row) => sum + (row.sum?.requests ?? 0), 0);
}

export type HeavyClient = { ip: string; requests: number; userAgent: string };

export async function fetchHeavyClients(gql: GraphqlFetch, zoneId: string, now: Date, limit = IP_HOURLY_LIMIT): Promise<HeavyClient[]> {
  const start = new Date(now.getTime() - 3_600_000);
  const data = (await gql(CLIENT_IP_QUERY, { zone: zoneId, start: start.toISOString(), end: now.toISOString() })) as {
    viewer?: { zones?: Array<{ httpRequestsAdaptiveGroups?: Array<{ count?: number; dimensions?: { clientIP?: string; userAgent?: string } }> }> };
  };
  const zone = data?.viewer?.zones?.[0];
  if (!zone) throw new CloudflareGraphqlError(`no zone data returned for ${zoneId} (wrong CF_ZONE_ID or token scope)`);
  const byIp = new Map<string, { total: number; topUa: string; topUaCount: number }>();
  for (const row of zone.httpRequestsAdaptiveGroups ?? []) {
    const ip = row.dimensions?.clientIP;
    if (!ip) continue;
    const count = row.count ?? 0;
    const entry = byIp.get(ip) ?? { total: 0, topUa: "", topUaCount: -1 };
    entry.total += count;
    if (count > entry.topUaCount) {
      entry.topUa = row.dimensions?.userAgent ?? "";
      entry.topUaCount = count;
    }
    byIp.set(ip, entry);
  }
  return [...byIp.entries()]
    .filter(([, e]) => e.total > limit)
    .map(([ip, e]) => ({ ip, requests: e.total, userAgent: e.topUa || "(none)" }))
    .sort((a, b) => b.requests - a.requests);
}

export type QuotaState = { date: string; levelsAlerted: number[]; ipsAlerted: string[] };

export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Alert flags reset at the UTC day boundary, matching Cloudflare's daily quota reset. */
export function freshState(previous: QuotaState | null, now: Date): QuotaState {
  if (previous && previous.date === utcDate(now)) {
    return { date: previous.date, levelsAlerted: [...previous.levelsAlerted], ipsAlerted: [...previous.ipsAlerted] };
  }
  return { date: utcDate(now), levelsAlerted: [], ipsAlerted: [] };
}

export type QuotaDecision = { state: QuotaState; messages: string[] };

/** Each threshold and each offending IP alerts once per UTC day. */
export function decideQuota(previous: QuotaState | null, invocations: number, heavy: HeavyClient[], now: Date): QuotaDecision {
  const state = freshState(previous, now);
  const messages: string[] = [];
  const crossed = QUOTA_THRESHOLDS.filter((t) => invocations >= t && !state.levelsAlerted.includes(t));
  if (crossed.length > 0) {
    const level = Math.max(...crossed);
    state.levelsAlerted.push(...crossed);
    const pct = Math.round((invocations / DAILY_FREE_CAP) * 100);
    messages.push(
      `:warning: Workers invocations today (UTC): ${invocations.toLocaleString("en-US")} of ${DAILY_FREE_CAP.toLocaleString("en-US")} free cap (${pct}%), crossed ${level.toLocaleString("en-US")}. At 100% the site serves a static 404 (datacrew-site#241).`,
    );
  }
  const newHeavy = heavy.filter((c) => !state.ipsAlerted.includes(c.ip));
  if (newHeavy.length > 0) {
    state.ipsAlerted.push(...newHeavy.map((c) => c.ip));
    messages.push(
      [
        `:warning: Client IPs over ${IP_HOURLY_LIMIT.toLocaleString("en-US")} requests in the last hour on datacrew.space:`,
        ...newHeavy.map((c) => `- ${c.ip}: ${c.requests.toLocaleString("en-US")} requests, UA: ${c.userAgent}`),
      ].join("\n"),
    );
  }
  return { state, messages };
}

export type QuotaDeps = {
  gql: GraphqlFetch;
  accountId: string;
  zoneId: string;
  previous: () => Promise<QuotaState | null>;
  notify: (text: string) => Promise<void>;
  now: Date;
};

export type QuotaResult = { invocations: number; heavyClients: HeavyClient[]; state: QuotaState; alerts: number };

export async function runQuotaCheck(deps: QuotaDeps): Promise<QuotaResult> {
  const previous = await deps.previous();
  const invocations = await fetchInvocationsToday(deps.gql, deps.accountId, deps.now);
  const heavyClients = await fetchHeavyClients(deps.gql, deps.zoneId, deps.now);
  const { state, messages } = decideQuota(previous, invocations, heavyClients, deps.now);
  for (const message of messages) await deps.notify(message);
  return { invocations, heavyClients, state, alerts: messages.length };
}
