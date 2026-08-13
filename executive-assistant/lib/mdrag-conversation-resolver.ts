/**
 * Resolve-or-create helper for mdrag conversation resources.
 *
 * Flow:
 * 1) Read-only resolve via /api/v1/me/resources/resolve
 * 2) If not found, create via /api/v1/conversations/
 */

/**
 * Where mdrag is, with no default — because the only sensible-looking default
 * is the one host that breaks this file.
 *
 * These requests carry identity in `X-User-Email` + `X-Internal-Secret`
 * (`buildHeaders` below). `wiki.datacrew.space/api/v1/*` terminates at mdrag's
 * own Next.js proxy, where both are PROXY_TRUST_HEADERS: stripped from every
 * inbound request and re-injected only when the proxy vouches, and it vouches
 * only for a caller with no credentials of its own. A server-to-server caller
 * has no NextAuth session to be vouched from, so the headers are dropped and
 * every user arrives as the same nobody — silently, with a 200. That is the
 * anti-spoofing boundary working as designed; it was diagnosed the hard way in
 * trigger-dev-workflows#36 and is spelled out in capitals in
 * `openai_compat/router.py::_caller_email`.
 *
 * This used to default to exactly that hostname. Anyone who deployed a worker
 * without setting `MDRAG_URL` got collapsed identities and no error to explain
 * it. On bonker the correct value is `http://mdrag-local:8017`, reachable over
 * `ai-network`.
 *
 * Resolved per call rather than at module load: this module is imported
 * transitively by tasks that never resolve a conversation, and throwing at
 * import would take those down over a variable they don't use. Failing here
 * still fails on the first request that actually needs it, which is the moment
 * that matters.
 */
function mdragUrl(): string {
  const raw = (process.env.MDRAG_URL ?? "").trim();
  if (!raw) {
    throw new Error(
      "MDRAG_URL is required and has no default. Set it to mdrag's DIRECT address " +
        "(on bonker: http://mdrag-local:8017). Do NOT use https://wiki.datacrew.space — " +
        "that host strips X-User-Email/X-Internal-Secret, so every caller silently " +
        "resolves to the same identity."
    );
  }
  return raw.replace(/\/+$/, "");
}
const MDRAG_TOKEN = process.env.MDRAG_TOKEN ?? "";
const MDRAG_INTERNAL_SECRET = process.env.MDRAG_INTERNAL_SECRET ?? "";

// TIMEOUT ADDED 2026-08-13 (pre-existing bug, found auditing MDRAG_TOKEN's
// other callers after fixing report-mdrag.ts's timeout — trigger-dev-workflows
// PR #62). Neither fetch below had a `signal`: unlike every other mdrag/Letta
// call in this project, a stalled resolve or create here could hang the task
// indefinitely with no client-side circuit breaker — the task never throws,
// so Trigger.dev's `retry` never fires. 120s matches the "plain mdrag API
// call, not itself an LLM completion" precedent (lib/mdrag-seen-articles.ts's
// MDRAG_REQUEST_TIMEOUT_MS, output-mdrag-ingest*.ts) rather than the 180s used
// for mdrag-primitives.ts's LLM-backed calls — resolve is a metadata lookup,
// and create provisions a conversation record (and possibly a Letta agent),
// neither of which runs an LLM completion itself.
const MDRAG_CONVERSATION_TIMEOUT_MS = 120_000;

export type CollectionScope = "all_accessible" | "explicit" | "user_default";
export type MdragAuthMode = "internal_secret" | "token";

export type ResolveOrCreateConversationInput = {
  userId: string;
  userEmail?: string;
  collectionId?: string;
  collectionScope?: CollectionScope;
  mode?: "ask" | "learn";
  title?: string;
  preResolved?: ResolveResponse;
  /**
   * Exact-match key scoped to (caller's user_email, externalRef) — mdrag
   * #1027. When set, resolution bypasses collection_scope/mode-based
   * matching entirely: deterministic found/not_found, never "ambiguous".
   * Lets a caller (e.g. a STORM research run) resolve straight back to the
   * SAME conversation on every call within a run, without needing to know
   * or match on a collection. Absent by default — every existing caller
   * (e.g. Pattern Hunter) sees zero behavior change.
   */
  externalRef?: string;
};

export type ResolveOrCreateConversationResult = {
  conversationId: string;
  agentId?: string;
  source: "resolved" | "created";
  appliedCollectionId?: string;
  resolvedStatus: ResolveResponse["status"];
  resolvedReason: string;
  authMode: MdragAuthMode;
  resolvedUserEmail?: string;
};

export type ResolveResponse = {
  status: "found" | "not_found" | "ambiguous";
  reason: string;
  applied_collection_id?: string | null;
  resource: {
    resource_id: string;
    provider_resource_id?: string | null;
  } | null;
  candidates: Array<{
    resource_id: string;
    provider_resource_id?: string | null;
  }>;
};

type CreateConversationResponse = {
  conversation_id: string;
  agent_id?: string | null;
  /** Round-trips the external_ref set at creation (mdrag #1027). */
  external_ref?: string | null;
};

type HeaderContext = {
  headers: Record<string, string>;
  authMode: MdragAuthMode;
  resolvedUserEmail?: string;
};

export type ResolveCollectionInput = {
  userEmail?: string;
  collectionId?: string;
  collectionScope?: CollectionScope;
  mode?: "ask" | "learn";
  /**
   * Exact-match key scoped to (caller's user_email, externalRef) — mdrag
   * #1027. When set, the server bypasses collection_scope/mode-based
   * matching for this call entirely and resolves deterministic
   * found/not_found against (user_email, externalRef) instead — the
   * resolved `applied_collection_id` on that response is always null,
   * since collection resolution never runs on this path. Absent by
   * default: every existing caller sees zero behavior change.
   */
  externalRef?: string;
};

export type ResolveCollectionResult = {
  resolved: ResolveResponse;
  requestedCollectionId?: string;
  requestedCollectionScope: CollectionScope;
  appliedCollectionId?: string;
  mode: "ask" | "learn";
  authMode: MdragAuthMode;
  resolvedUserEmail?: string;
};

function buildHeaders(userEmail?: string): HeaderContext {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (MDRAG_INTERNAL_SECRET && userEmail) {
    headers["X-Internal-Secret"] = MDRAG_INTERNAL_SECRET;
    headers["X-User-Email"] = userEmail;
    return {
      headers,
      authMode: "internal_secret",
      resolvedUserEmail: userEmail.trim() || undefined,
    };
  }

  if (!MDRAG_TOKEN) {
    throw new Error(
      "MDRAG auth not configured. Set MDRAG_TOKEN, or set MDRAG_INTERNAL_SECRET and userEmail"
    );
  }

  // `Authorization: Bearer`, not `X-DC-Token` (live-verified 2026-08-12: a
  // valid MDRAG_TOKEN sent as X-DC-Token passes mdrag's outer admission gate
  // fine, but /me/resources/resolve and /conversations/ resolve identity via
  // get_current_user -> get_user_email(), which checks Authorization: Bearer
  // (JWT-verified, via the token's own email claim) first and X-User-Email
  // second — X-DC-Token isn't part of that check at all, so every call
  // resolved anonymous regardless of who the token actually belongs to).
  // Same header STORM's /ingest/* calls already use successfully with this
  // exact token value (output-mdrag-ingest.ts).
  headers["Authorization"] = `Bearer ${MDRAG_TOKEN}`;
  return { headers, authMode: "token" };
}

function defaultConversationTitle(userId: string): string {
  const normalized = userId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `datacrew-space-${normalized || "user"}`;
}

export async function resolveConversationCollection(
  input: ResolveCollectionInput
): Promise<ResolveCollectionResult> {
  const mode = input.mode ?? "ask";
  const collectionId = input.collectionId?.trim() || undefined;
  const collectionScope = input.collectionScope ?? (collectionId ? "explicit" : "user_default");
  if (collectionScope === "explicit" && !collectionId) {
    throw new Error("collectionId is required when collectionScope=explicit");
  }

  const headerContext = buildHeaders(input.userEmail);
  const resolveRes = await fetch(`${mdragUrl()}/api/v1/me/resources/resolve`, {
    method: "POST",
    headers: headerContext.headers,
    body: JSON.stringify({
      kind: "conversation",
      provider: "letta",
      collection_scope: collectionScope,
      collection_id: collectionId,
      mode,
      ...(input.externalRef ? { external_ref: input.externalRef } : {}),
    }),
    signal: AbortSignal.timeout(MDRAG_CONVERSATION_TIMEOUT_MS),
  });

  const resolveText = await resolveRes.text();
  if (!resolveRes.ok) {
    throw new Error(`mdrag resolve failed: ${resolveRes.status} ${resolveText}`);
  }

  const resolved = JSON.parse(resolveText) as ResolveResponse;
  return {
    resolved,
    requestedCollectionId: collectionId,
    requestedCollectionScope: collectionScope,
    appliedCollectionId: resolved.applied_collection_id ?? undefined,
    mode,
    authMode: headerContext.authMode,
    resolvedUserEmail: headerContext.resolvedUserEmail,
  };
}

export async function resolveOrCreateConversation(
  input: ResolveOrCreateConversationInput
): Promise<ResolveOrCreateConversationResult> {
  const mode = input.mode ?? "ask";
  const headerContext = buildHeaders(input.userEmail);
  const resolvedFromApi =
    input.preResolved ??
    (
      await resolveConversationCollection({
        userEmail: input.userEmail,
        collectionId: input.collectionId,
        collectionScope: input.collectionScope,
        mode,
        externalRef: input.externalRef,
      })
    ).resolved;
  const resolved = resolvedFromApi;
  const requestedCollectionId = input.collectionId?.trim() || undefined;

  if (resolved.status === "found" && resolved.resource?.resource_id) {
    return {
      conversationId: resolved.resource.resource_id,
      agentId: resolved.resource.provider_resource_id ?? undefined,
      source: "resolved",
      appliedCollectionId: resolved.applied_collection_id ?? requestedCollectionId,
      resolvedStatus: resolved.status,
      resolvedReason: resolved.reason,
      authMode: headerContext.authMode,
      resolvedUserEmail: headerContext.resolvedUserEmail,
    };
  }

  if (resolved.status === "ambiguous") {
    const ids = resolved.candidates.map((c) => c.resource_id).join(", ");
    throw new Error(
      `mdrag resolve ambiguous for user conversation (candidates: ${ids || "none"})`
    );
  }

  let createCollectionId = requestedCollectionId ?? resolved.applied_collection_id ?? undefined;

  // The external_ref exact-match path (mdrag #1027) bypasses collection
  // resolution entirely, so a miss on that path always comes back with
  // applied_collection_id=null — it never tells us where to create. If the
  // caller also didn't pass an explicit collectionId, fall back to a normal
  // (non-external_ref) collection resolution — e.g. collection_scope
  // defaulting to the caller's own personal collection — purely to get a
  // destination to create into. This only runs on the externalRef path;
  // every other caller's behavior (including the "no collection_id
  // available" error below) is unchanged.
  if (!createCollectionId && input.externalRef) {
    const collectionFallback = await resolveConversationCollection({
      userEmail: input.userEmail,
      collectionId: input.collectionId,
      collectionScope: input.collectionScope,
      mode,
    });
    createCollectionId = collectionFallback.appliedCollectionId;
  }

  if (!createCollectionId) {
    throw new Error(
      `Cannot create conversation after resolve miss: no collection_id available (reason=${resolved.reason})`
    );
  }

  const createRes = await fetch(`${mdragUrl()}/api/v1/conversations/`, {
    method: "POST",
    headers: headerContext.headers,
    body: JSON.stringify({
      collection_id: createCollectionId,
      mode,
      title: input.title ?? defaultConversationTitle(input.userId),
      ...(input.externalRef ? { external_ref: input.externalRef } : {}),
    }),
    signal: AbortSignal.timeout(MDRAG_CONVERSATION_TIMEOUT_MS),
  });

  const createText = await createRes.text();
  if (!createRes.ok) {
    throw new Error(`mdrag create conversation failed: ${createRes.status} ${createText}`);
  }

  const created = JSON.parse(createText) as CreateConversationResponse;
  if (!created.conversation_id) {
    throw new Error(`mdrag create conversation returned no conversation_id: ${createText}`);
  }

  return {
    conversationId: created.conversation_id,
    agentId: created.agent_id ?? undefined,
    source: "created",
    appliedCollectionId: createCollectionId,
    resolvedStatus: resolved.status,
    resolvedReason: resolved.reason,
    authMode: headerContext.authMode,
    resolvedUserEmail: headerContext.resolvedUserEmail,
  };
}
