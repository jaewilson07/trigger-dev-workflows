/**
 * Decides whether a Letta send may pin a per-request `override_model`.
 *
 * The `letta-quota-fallback` watchdog (trigger-dev-workflows#281) moves an
 * exhausted agent onto the house model and records
 * `metadata.auto_fallback = {previous, switched_at, resets_at}`. A per-request
 * `override_model` beats the agent's own model, so a caller that keeps pinning
 * `letta/auto-fast` stays on the exhausted quota. While the record is present
 * the override must be omitted; the record itself is the switch, no config.
 *
 * The metadata read must never block a send: on any failure the override is
 * kept (the pre-#287 behaviour) and a warning is logged.
 */

export type OverrideTarget = string | { conversationId: string };

export type OverrideResolverDeps = {
  baseUrl: string;
  apiKey: string;
  ttlMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TTL_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;

/** Returns `model`, or `undefined` when the target agent is on house-model fallback. */
export function createOverrideResolver(deps: OverrideResolverDeps) {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const doFetch = deps.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${deps.apiKey}` };
  const cache = new Map<string, { onFallback: boolean; at: number }>();

  async function getJson(path: string): Promise<Record<string, unknown>> {
    const res = await doFetch(`${deps.baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  return async function resolveOverride(
    target: OverrideTarget,
    model: string
  ): Promise<string | undefined> {
    try {
      const agentId =
        typeof target === "string"
          ? target
          : String((await getJson(`/v1/conversations/${target.conversationId}`)).agent_id ?? "");
      if (!agentId) throw new Error("conversation has no agent_id");

      const hit = cache.get(agentId);
      if (hit && now() - hit.at < ttlMs) return hit.onFallback ? undefined : model;

      const agent = await getJson(`/v1/agents/${agentId}`);
      const metadata = agent.metadata as { auto_fallback?: unknown } | null | undefined;
      const onFallback = Boolean(metadata?.auto_fallback);
      cache.set(agentId, { onFallback, at: now() });
      return onFallback ? undefined : model;
    } catch (err) {
      warn(`letta-override: metadata read failed, keeping override_model: ${String(err)}`);
      return model;
    }
  };
}
