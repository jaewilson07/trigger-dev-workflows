import { task, logger, metadata } from "@trigger.dev/sdk";
import {
  resolveConversationCollection,
  type CollectionScope,
  type MdragAuthMode,
  type ResolveResponse,
} from "../lib/mdrag-conversation-resolver.js";

export type GetUsersCollectionPayload = {
  userId: string;
  userEmail?: string;
  collectionId?: string;
  collectionScope?: CollectionScope;
  mode?: "ask" | "learn";
};

export type GetUsersCollectionResult = {
  userId: string;
  userEmail?: string;
  authMode: MdragAuthMode;
  requestedCollectionId?: string;
  requestedCollectionScope: CollectionScope;
  appliedCollectionId?: string;
  resolve: ResolveResponse;
};

export const getUsersCollection = task({
  id: "get-users-collection",
  retry: { maxAttempts: 2 },
  run: async (payload: GetUsersCollectionPayload): Promise<GetUsersCollectionResult> => {
    logger.info("get-users-collection starting", {
      userId: payload.userId,
      collectionScope: payload.collectionScope,
      mode: payload.mode,
    });

    if (!payload.userId?.trim()) {
      throw new Error("userId is required");
    }

    const resolved = await resolveConversationCollection({
      userEmail: payload.userEmail,
      collectionId: payload.collectionId,
      collectionScope: payload.collectionScope,
      mode: payload.mode,
    });

    const result: GetUsersCollectionResult = {
      userId: payload.userId,
      userEmail: resolved.resolvedUserEmail,
      authMode: resolved.authMode,
      requestedCollectionId: resolved.requestedCollectionId,
      requestedCollectionScope: resolved.requestedCollectionScope,
      appliedCollectionId: resolved.appliedCollectionId,
      resolve: resolved.resolved,
    };

    metadata
      .set("user_id", payload.userId)
      .set("auth_mode", result.authMode)
      .set("requested_collection_scope", result.requestedCollectionScope)
      .set("applied_collection_id", result.appliedCollectionId ?? null)
      .set("resolve_status", result.resolve.status)
      .set("resolve_reason", result.resolve.reason);

    logger.info("get-users-collection completed — resolved user collection context", {
      userId: payload.userId,
      authMode: result.authMode,
      requestedCollectionScope: result.requestedCollectionScope,
      requestedCollectionId: result.requestedCollectionId,
      appliedCollectionId: result.appliedCollectionId,
      resolveStatus: result.resolve.status,
      resolveReason: result.resolve.reason,
    });

    return result;
  },
});
