import { task, logger } from "@trigger.dev/sdk";
import { patternHunterFullRun } from "./pattern-hunter-full-run.js";
import type { PatternHunterFullRunResult } from "./pattern-hunter-full-run.js";
import {
  conversationAgentJson,
  conversationAgentReply,
  resolveBackend,
  type ConversationAgentBackend,
} from "./lib/conversation-agent.js";
import { getUsersCollection } from "./tasks/get-users-collection.js";
import { getUsersLetta, type GetUsersLettaResult } from "./tasks/get-users-letta.js";

/**
 * What a session needs downstream, whether or not mdrag was ever asked to
 * create a Conversation for it.
 *
 * Anonymous + Claude deliberately never calls mdrag at all here (ADR 0030
 * Addendum, point 3: Claude generates statelessly, so nothing needs a
 * Conversation until registration — the transcript is written back then, by
 * `pattern-hunter-reflect`). This stub is what an unresolved session looks
 * like in that case: every field the real resolver returns is absent, not
 * defaulted to an operator's identity.
 */
type ResolvedSession = Partial<
  Pick<
    GetUsersLettaResult,
    "userEmail" | "authMode" | "conversationId" | "agentId" | "source" | "appliedCollectionId"
  >
>;

const ANONYMOUS_STUB: ResolvedSession = {
  userEmail: undefined,
  authMode: undefined,
  conversationId: undefined,
  agentId: undefined,
  source: undefined,
  appliedCollectionId: undefined,
};

export type PatternHunterIntakeState = {
  business_input?: string;
  operator_profile?: string;
  primary_constraint?: string;
  risk_tolerance?: "low" | "medium" | "high";
  success_horizon_days?: number;
  notes: string[];
};

export type PatternHunterChatPayload = {
  session_id: string;
  user_id: string;
  message: string;
  user_email?: string;
  collection_id?: string;
  collection_scope?: "all_accessible" | "explicit" | "user_default";
  conversation_mode?: "ask" | "learn";
  conversation_title?: string;
  state?: Partial<PatternHunterIntakeState>;
  run_when_ready?: boolean;
  backend?: ConversationAgentBackend;
};

type RouteDecision = "ask_followup" | "chat" | "run_full";

type IntakeExtraction = {
  business_input?: string;
  operator_profile?: string;
  primary_constraint?: string;
  risk_tolerance?: "low" | "medium" | "high";
  success_horizon_days?: number;
  notes?: string[];
  user_intent?: "explore" | "clarify" | "run_now";
};

type PatternHunterChatResult = {
  session_id: string;
  user_id: string;
  backend_used: "letta" | "claude";
  resolved_user_email?: string;
  resolution_auth_mode?: "internal_secret" | "token";
  applied_collection_id?: string;
  conversation_id?: string;
  conversation_source?: "resolved" | "created";
  letta_agent_id?: string;
  route: RouteDecision;
  reply: string;
  state: PatternHunterIntakeState;
  readiness_score: number;
  missing_fields: string[];
  full_run?: {
    run_id: string;
    status: "completed" | "failed";
    duration_ms: number;
    report_summary: string;
    report: PatternHunterFullRunResult["report"];
  };
};

const REQUIRED_FIELDS = [
  "business_input",
  "operator_profile",
  "primary_constraint",
  "risk_tolerance",
  "success_horizon_days",
] as const;

function normalizeState(input?: Partial<PatternHunterIntakeState>): PatternHunterIntakeState {
  return {
    business_input: input?.business_input?.trim() || undefined,
    operator_profile: input?.operator_profile?.trim() || undefined,
    primary_constraint: input?.primary_constraint?.trim() || undefined,
    risk_tolerance:
      input?.risk_tolerance === "low" ||
      input?.risk_tolerance === "medium" ||
      input?.risk_tolerance === "high"
        ? input.risk_tolerance
        : undefined,
    success_horizon_days:
      typeof input?.success_horizon_days === "number" && Number.isFinite(input.success_horizon_days)
        ? Math.max(1, Math.round(input.success_horizon_days))
        : undefined,
    notes: Array.isArray(input?.notes)
      ? input.notes.filter((note): note is string => typeof note === "string" && note.trim() !== "")
      : [],
  };
}

function mergeState(state: PatternHunterIntakeState, patch: IntakeExtraction): PatternHunterIntakeState {
  const next: PatternHunterIntakeState = {
    ...state,
    business_input: patch.business_input?.trim() || state.business_input,
    operator_profile: patch.operator_profile?.trim() || state.operator_profile,
    primary_constraint: patch.primary_constraint?.trim() || state.primary_constraint,
    risk_tolerance:
      patch.risk_tolerance === "low" ||
      patch.risk_tolerance === "medium" ||
      patch.risk_tolerance === "high"
        ? patch.risk_tolerance
        : state.risk_tolerance,
    success_horizon_days:
      typeof patch.success_horizon_days === "number" && Number.isFinite(patch.success_horizon_days)
        ? Math.max(1, Math.round(patch.success_horizon_days))
        : state.success_horizon_days,
    notes: state.notes,
  };

  if (Array.isArray(patch.notes)) {
    const patchNotes = patch.notes.filter((note): note is string => typeof note === "string" && note.trim() !== "");
    next.notes = [...state.notes, ...patchNotes].slice(-20);
  }

  return next;
}

function missingFields(state: PatternHunterIntakeState): string[] {
  return REQUIRED_FIELDS.filter((field) => {
    const value = state[field];
    return value === undefined || value === "";
  }).map((field) => String(field));
}

function readinessScore(state: PatternHunterIntakeState): number {
  const missing = missingFields(state).length;
  return Math.max(0, Math.round(((REQUIRED_FIELDS.length - missing) / REQUIRED_FIELDS.length) * 100));
}

function summarizeReport(result: PatternHunterFullRunResult): string {
  const stepsDone = result.report.steps.filter((step) => step.status === "done").length;
  const failed = result.report.steps.find((step) => step.status === "failed");
  if (failed) {
    return `Research run failed at ${failed.label}: ${failed.error ?? failed.summary}`;
  }
  return `Research run completed (${stepsDone}/${result.report.steps.length} steps).`;
}

const EXTRACTION_SYSTEM_PROMPT = `You are extracting structured intake for Pattern Hunter.
Only extract facts that are explicitly stated or very strongly implied.
Do not invent values.
If a field is unknown, omit it.`;

function buildExtractionPrompt(payload: PatternHunterChatPayload, state: PatternHunterIntakeState): string {
  return [
    "Current intake state JSON:",
    JSON.stringify(state),
    "",
    "New user message:",
    payload.message,
    "",
    "Extract a JSON object with optional keys:",
    "business_input, operator_profile, primary_constraint, risk_tolerance (low|medium|high), success_horizon_days (integer), notes (string[]), user_intent (explore|clarify|run_now).",
  ].join("\n");
}

function pickRoute(
  intent: IntakeExtraction["user_intent"],
  state: PatternHunterIntakeState,
  runWhenReady: boolean
): RouteDecision {
  const missing = missingFields(state);
  const ready = missing.length === 0;

  if (intent === "run_now" && ready) return "run_full";
  if (runWhenReady && ready) return "run_full";
  if (!ready) return "ask_followup";
  return "chat";
}

function followupQuestion(state: PatternHunterIntakeState): string {
  const missing = missingFields(state);
  if (missing.length === 0) {
    return "I have everything needed for a full Pattern Hunter run. Say 'run it now' when you're ready.";
  }

  const first = missing[0];
  if (first === "business_input") {
    return "What business or industry should we analyze first?";
  }
  if (first === "operator_profile") {
    return "Who is the operator profile (team size, role, and context)?";
  }
  if (first === "primary_constraint") {
    return "What is the main bottleneck right now (cash flow, hiring, utilization, lead gen, compliance, etc.)?";
  }
  if (first === "risk_tolerance") {
    return "How risk-tolerant should recommendations be: low, medium, or high?";
  }
  return "What is the target horizon in days for seeing measurable improvement?";
}

function formatTaskError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export const patternHunterChatSession = task({
  id: "pattern-hunter-chat-session",
  retry: { maxAttempts: 2 },
  run: async (payload: PatternHunterChatPayload): Promise<PatternHunterChatResult> => {
    if (!payload.session_id?.trim()) throw new Error("session_id is required");
    if (!payload.user_id?.trim()) throw new Error("user_id is required");
    if (!payload.message?.trim()) throw new Error("message is required");

    const conversationCollectionId = payload.collection_id;
    const conversationCollectionScope =
      payload.collection_scope ?? (conversationCollectionId ? "explicit" : "user_default");

    const conversationMode = payload.conversation_mode ?? "ask";
    // No operator fallback here on purpose. A visitor with no email is
    // anonymous, full stop — silently attributing their session to
    // MORNING_BRIEF_USER_EMAIL is exactly the bug ADR 0030's Addendum (its
    // "known offenders" section) calls out: strangers' interviews landing in
    // the operator's own agent memory, and priming it for the next visitor.
    const conversationUserEmail = payload.user_email?.trim() || undefined;
    const effectiveBackend = resolveBackend(payload.backend);

    let resolvedConversation: ResolvedSession;

    if (!conversationUserEmail) {
      // Anonymous. Whether this needs a Conversation at all depends on the
      // backend (ADR 0030 Addendum, point 3) — the two paths are not
      // interchangeable, so this is a real branch, not a shortcut.
      if (effectiveBackend === "letta") {
        // Letta generates *inside* the Conversation, so one must exist before
        // the first turn. Creating an anonymous one requires a public
        // Collection an anonymous caller can legally reach — that capability
        // doesn't exist yet (ADR 0030 Addendum: "Anonymous access needs a
        // capability, not `public` visibility — unresolved"). Refusing loudly
        // beats either fabricating an identity or minting a Conversation on
        // whatever Collection happens to be passed.
        throw new Error(
          "Anonymous Pattern Hunter sessions aren't supported on the Letta backend yet " +
            "(no anonymous-reachable Collection exists — ADR 0030 Addendum). " +
            "Sign in, or set PATTERN_HUNTER_AGENT_BACKEND=claude / pass backend=\"claude\"."
        );
      }
      // Claude generates statelessly, so nothing needs a Conversation until
      // there's a person to attribute the session to — that happens at
      // registration, not here (`pattern-hunter-reflect` writes the
      // transcript back then). No mdrag call at all for this session.
      resolvedConversation = ANONYMOUS_STUB;
    } else {
      const usersCollection = await getUsersCollection.triggerAndWait({
        userId: payload.user_id,
        userEmail: conversationUserEmail,
        collectionId: conversationCollectionId,
        collectionScope: conversationCollectionScope,
        mode: conversationMode,
      });
      if (!usersCollection.ok) {
        throw new Error(`get-users-collection failed: ${formatTaskError(usersCollection.error)}`);
      }

      const usersLetta = await getUsersLetta.triggerAndWait({
        userId: payload.user_id,
        userEmail: conversationUserEmail,
        collectionId: usersCollection.output.requestedCollectionId,
        collectionScope: usersCollection.output.requestedCollectionScope,
        mode: conversationMode,
        title: payload.conversation_title,
        preResolved: usersCollection.output.resolve,
      });
      if (!usersLetta.ok) {
        throw new Error(`get-users-letta failed: ${formatTaskError(usersLetta.error)}`);
      }
      resolvedConversation = usersLetta.output;
    }

    const state = normalizeState(payload.state);
    const runWhenReady = payload.run_when_ready ?? true;

    const extraction = await conversationAgentJson<IntakeExtraction>({
      backend: payload.backend,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      userPrompt: buildExtractionPrompt(payload, state),
      maxTokens: 500,
      temperature: 0,
      lettaAgentId: resolvedConversation.agentId,
      lettaUserEmail: resolvedConversation.userEmail ?? conversationUserEmail,
    });

    const nextState = mergeState(state, extraction.value);
    const route = pickRoute(extraction.value.user_intent, nextState, runWhenReady);
    const missing = missingFields(nextState);
    const score = readinessScore(nextState);

    if (route === "run_full") {
      logger.info("pattern-hunter-chat-session launching full run", {
        sessionId: payload.session_id,
        userId: payload.user_id,
        businessInput: nextState.business_input,
      });

      const runResult = await patternHunterFullRun
        .triggerAndWait({
          business_input: nextState.business_input ?? payload.message,
          industry: nextState.business_input,
          persona: {
            role: nextState.operator_profile ?? "Operator",
            concerns: [nextState.primary_constraint ?? "unknown"],
            focus_areas: [
              nextState.primary_constraint ?? "unknown",
              `risk:${nextState.risk_tolerance ?? "unknown"}`,
              `horizon_days:${nextState.success_horizon_days ?? "unknown"}`,
            ],
            reference_urls: [],
          },
        })
        .unwrap();

      const reportSummary = summarizeReport(runResult);

      logger.info("pattern-hunter-chat-session completed — full run finished", {
        sessionId: payload.session_id,
        runId: runResult.run_id,
        status: runResult.status,
        durationMs: runResult.duration_ms,
      });

      const completionReply =
        runResult.status === "completed"
          ? "Research run is complete. I can now walk you through pain points, hypotheses, and recommended actions."
          : "The research run failed before completion. I can help diagnose and retry with tighter scope.";

      return {
        session_id: payload.session_id,
        user_id: payload.user_id,
        backend_used: extraction.backend,
        resolved_user_email: resolvedConversation.userEmail,
        resolution_auth_mode: resolvedConversation.authMode,
        applied_collection_id: resolvedConversation.appliedCollectionId,
        conversation_id: resolvedConversation.conversationId,
        conversation_source: resolvedConversation.source,
        letta_agent_id: resolvedConversation.agentId,
        route,
        reply: `${completionReply}\n\n${reportSummary}`,
        state: nextState,
        readiness_score: score,
        missing_fields: missing,
        full_run: {
          run_id: runResult.run_id,
          status: runResult.status,
          duration_ms: runResult.duration_ms,
          report_summary: reportSummary,
          report: runResult.report,
        },
      };
    }

    if (route === "ask_followup") {
      return {
        session_id: payload.session_id,
        user_id: payload.user_id,
        backend_used: extraction.backend,
        resolved_user_email: resolvedConversation.userEmail,
        resolution_auth_mode: resolvedConversation.authMode,
        applied_collection_id: resolvedConversation.appliedCollectionId,
        conversation_id: resolvedConversation.conversationId,
        conversation_source: resolvedConversation.source,
        letta_agent_id: resolvedConversation.agentId,
        route,
        reply: followupQuestion(nextState),
        state: nextState,
        readiness_score: score,
        missing_fields: missing,
      };
    }

    const chatReply = await conversationAgentReply({
      backend: payload.backend,
      systemPrompt:
        "You are Pattern Hunter's conversational strategist. Be concise, operator-first, and practical. Avoid generic MBA language.",
      userPrompt: [
        "User message:",
        payload.message,
        "",
        "Current intake state:",
        JSON.stringify(nextState),
        "",
        "Reply in 3-6 sentences. If helpful, ask one high-value clarifying question.",
      ].join("\n"),
      maxTokens: 600,
      temperature: 0.2,
      lettaAgentId: resolvedConversation.agentId,
      lettaUserEmail: resolvedConversation.userEmail ?? conversationUserEmail,
    });

    return {
      session_id: payload.session_id,
      user_id: payload.user_id,
      backend_used: chatReply.backend,
      resolved_user_email: resolvedConversation.userEmail,
      resolution_auth_mode: resolvedConversation.authMode,
      applied_collection_id: resolvedConversation.appliedCollectionId,
      conversation_id: resolvedConversation.conversationId,
      conversation_source: resolvedConversation.source,
      letta_agent_id: resolvedConversation.agentId,
      route,
      reply: chatReply.text,
      state: nextState,
      readiness_score: score,
      missing_fields: missing,
    };
  },
});
