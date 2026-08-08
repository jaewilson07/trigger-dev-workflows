import { task, logger, metadata } from "@trigger.dev/sdk";
import {
  resolveOrCreateConversation,
  type CollectionScope,
  type MdragAuthMode,
  type ResolveResponse,
} from "../lib/mdrag-conversation-resolver.js";

export type GetUsersLettaPayload = {
  userId: string;
  userEmail?: string;
  collectionId?: string;
  collectionScope?: CollectionScope;
  mode?: "ask" | "learn";
  title?: string;
  preResolved?: ResolveResponse;
};

export type GetUsersLettaResult = {
  userId: string;
  userEmail?: string;
  authMode: MdragAuthMode;
  conversationId: string;
  agentId?: string;
  source: "resolved" | "created";
  appliedCollectionId?: string;
  resolveStatus: ResolveResponse["status"];
  resolveReason: string;
};

export const getUsersLetta = task({
  id: "get-users-letta",
  retry: { maxAttempts: 2 },
  run: async (payload: GetUsersLettaPayload): Promise<GetUsersLettaResult> => {
    logger.info("get-users-letta starting", {
      userId: payload.userId,
      collectionScope: payload.collectionScope,
      mode: payload.mode,
    });

    if (!payload.userId?.trim()) {
      throw new Error("userId is required");
    }

    const result = await resolveOrCreateConversation({
      userId: payload.userId,
      userEmail: payload.userEmail,
      collectionId: payload.collectionId,
      collectionScope: payload.collectionScope,
      mode: payload.mode,
      title: payload.title,
      preResolved: payload.preResolved,
    });

    const response: GetUsersLettaResult = {
      userId: payload.userId,
      userEmail: result.resolvedUserEmail,
      authMode: result.authMode,
      conversationId: result.conversationId,
      agentId: result.agentId,
      source: result.source,
      appliedCollectionId: result.appliedCollectionId,
      resolveStatus: result.resolvedStatus,
      resolveReason: result.resolvedReason,
    };

    metadata
      .set("user_id", payload.userId)
      .set("auth_mode", response.authMode)
      .set("conversation_id", response.conversationId)
      .set("conversation_source", response.source)
      .set("applied_collection_id", response.appliedCollectionId ?? null)
      .set("resolve_status", response.resolveStatus)
      .set("resolve_reason", response.resolveReason);

    logger.info("get-users-letta completed — resolved user Letta conversation", {
      userId: payload.userId,
      authMode: response.authMode,
      conversationId: response.conversationId,
      conversationSource: response.source,
      agentId: response.agentId,
      appliedCollectionId: response.appliedCollectionId,
      resolveStatus: response.resolveStatus,
      resolveReason: response.resolveReason,
    });

    return response;
  },
});
