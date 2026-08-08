import { logger, task, wait } from "@trigger.dev/sdk";
import { patternHunterFullRun } from "./pattern-hunter-full-run.js";
import { conversationAgentJson, resolveBackend } from "./lib/conversation-agent.js";
import { renderWithFallbacks } from "./lib/prompt-template.js";
import { patternHunterReflect } from "./pattern-hunter-reflect.js";

/**
 * Human-in-the-loop Pattern Hunter interview.
 *
 * Alternates research rounds with waitpoints: after each round the run
 * suspends on a token and the frontend renders the question. Answering it
 * (POST /api/pattern-hunter/respond) completes the token and the run resumes.
 *
 * The interview is budgeted at four minutes. When the budget is spent the
 * agent asks once whether to finish or keep going, rather than deciding for
 * the visitor.
 */

const INTERVIEW_BUDGET_MS = 4 * 60 * 1000;
const MAX_ROUNDS = 6;

export type InterviewAnswer = {
  answer: string;
  intent: "answer" | "generate_now" | "keep_going";
  /**
   * Brief fields the visitor corrected by hand while this run was suspended.
   *
   * The waitpoint token is the ONLY channel into a suspended run, so an edge
   * the visitor makes in the brief panel has to travel on it — there is no
   * other way to reach a run parked on `wait.forToken`. Merged AFTER the
   * model's extraction so a human correction always outranks what the agent
   * inferred from their prose.
   */
  intake_patch?: Intake;
};

/**
 * The run's parameters. Mirrors IntakeState in the frontend
 * (types/pattern-hunter-chat.ts) — these are the fields the old intake form
 * collected, and `patternHunterFullRun` still needs them. The interview fills
 * them in; the visitor can correct any of them in the brief panel.
 */
export type Intake = {
  subject?: string;
  industry?: string;
  role?: string;
  concerns?: string[];
  focus_areas?: string[];
  reference_urls?: string[];
  primary_constraint?: string;
  risk_tolerance?: "low" | "medium" | "high";
  horizon_days?: number;
};

export type PatternHunterInterviewPayload = {
  session_id: string;
  /** The Conversation this session belongs to. Required to write the session
   * back at the end (ADR 0030 Addendum point 7). */
  conversation_id?: string;
  /** Admin platform setting — when false, the session is not written back. */
  ingest_to_letta?: boolean;
  subject: string;
  /** Whatever the caller already knows — a returning visitor, or fields the
   * visitor typed into the brief panel before the interview reached them. */
  intake?: Intake;
  /** Millisecond wall clock passed in by the caller — tasks shouldn't assume
   * the browser and the worker agree on when the interview started. */
  started_at?: number;
};

function formatTaskError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const REQUIRED_INTAKE_FIELDS = ["subject", "industry", "role", "primary_constraint"] as const;

function missingIntakeFields(intake: Intake): string[] {
  return REQUIRED_INTAKE_FIELDS.filter((field) => !intake[field]);
}

type RoundPlan = {
  /** One-line summary of what the round found, shown as an agent turn. */
  finding: string;
  /** Reasoning surfaced to the UI as a thinking block. */
  reasoning: string;
  /** The question to pause on. */
  question: string;
  /** Suggested answers; the visitor can always type their own. */
  options: string[];
  /** Which intake field the question is filling, so the answer files itself. */
  fills?: keyof Intake;
};

/** What the planner extracted from the visitor's answer. Kept separate from
 * the plan so a wrong extraction is visible in the brief panel rather than
 * silently shaping the run. */
type IntakeExtraction = Intake;

const PLANNER_SYSTEM_PROMPT = `You are Pattern Hunter's interview planner.
After each research round you propose exactly one high-value question that would
change what gets researched next. Prefer questions that fill a still-missing
intake field. Never ask something the transcript already answers.
Be specific to the operator's industry. No generic MBA language.`;

/**
 * Every subject-specific value is a `{{slot}}`, never inlined. A prompt with a
 * company name written into it produces a report about that company no matter
 * whose brief was passed in — which is exactly the bug the mock had.
 */
const PLANNER_TEMPLATE = `You are planning round {{round}} of a Pattern Hunter interview.

The operator:
- Company: {{subject}}
- Industry: {{industry}}
- Their role: {{role}}
- Biggest constraint: {{primary_constraint}}
- Concerns: {{concerns}}
- Focus areas: {{focus_areas}}
- Risk tolerance: {{risk_tolerance}}
- Horizon: {{horizon_days}}

{{missing_directive}}

Transcript so far:
{{transcript}}

Research {{subject}} specifically — never a generic company, and never an
example from another industry. Every finding must be about {{subject}} or about
{{industry}} as it bears on {{subject}}.

Return JSON with keys: finding (string), reasoning (string), question (string),
options (array of 2-3 short suggested answers), fills (the intake field this
question fills, or omit).`;

function buildPlannerPrompt(
  intake: Intake,
  transcript: string[],
  round: number
): string {
  const missing = missingIntakeFields(intake);
  return renderWithFallbacks(PLANNER_TEMPLATE, {
    round,
    subject: intake.subject,
    industry: intake.industry,
    role: intake.role,
    primary_constraint: intake.primary_constraint,
    concerns: intake.concerns?.join(", "),
    focus_areas: intake.focus_areas?.join(", "),
    risk_tolerance: intake.risk_tolerance,
    horizon_days: intake.horizon_days,
    transcript: transcript.length > 0 ? transcript.join("\n") : undefined,
    missing_directive:
      missing.length > 0
        ? `Still missing — ask about one of these first: ${missing.join(", ")}`
        : "The brief is complete. Ask about research direction instead.",
  }, {
    transcript: "(nothing yet)",
    concerns: "none given",
    focus_areas: "none given",
    risk_tolerance: "not stated — do not assume",
    horizon_days: "not stated — do not assume",
  });
}

const EXTRACTION_SYSTEM_PROMPT = `You extract Pattern Hunter intake from one answer.
Only extract what the answer explicitly states or strongly implies. Never invent a value.
Omit any field you are unsure about.`;

const EXTRACTION_TEMPLATE = `Question asked:
{{question}}

Answer from the operator at {{subject}}:
{{answer}}

Brief so far:
{{intake_json}}

Return a JSON object with any of: subject, industry, role, primary_constraint,
concerns (string[]), focus_areas (string[]), reference_urls (string[]),
risk_tolerance (low|medium|high), horizon_days (integer).
Omit any field the answer does not establish.`;

function buildExtractionPrompt(question: string, answer: string, intake: Intake): string {
  return renderWithFallbacks(EXTRACTION_TEMPLATE, {
    question,
    answer,
    subject: intake.subject,
    intake_json: JSON.stringify(intake),
  }, { subject: "the operator's company" });
}

/** Array fields append; scalars only fill an empty slot unless the extraction
 * is more specific. A later answer should add a concern, not replace the list. */
function mergeIntake(intake: Intake, patch: IntakeExtraction): Intake {
  const merge = (current: string[] = [], incoming?: string[]) =>
    incoming && incoming.length > 0
      ? Array.from(new Set([...current, ...incoming.map((s) => s.trim()).filter(Boolean)]))
      : current;

  return {
    ...intake,
    subject: patch.subject?.trim() || intake.subject,
    industry: patch.industry?.trim() || intake.industry,
    role: patch.role?.trim() || intake.role,
    primary_constraint: patch.primary_constraint?.trim() || intake.primary_constraint,
    risk_tolerance: patch.risk_tolerance ?? intake.risk_tolerance,
    horizon_days:
      typeof patch.horizon_days === "number" && Number.isFinite(patch.horizon_days)
        ? Math.max(1, Math.round(patch.horizon_days))
        : intake.horizon_days,
    concerns: merge(intake.concerns, patch.concerns),
    focus_areas: merge(intake.focus_areas, patch.focus_areas),
    reference_urls: merge(intake.reference_urls, patch.reference_urls),
  };
}

export const patternHunterInterview = task({
  id: "pattern-hunter-interview",
  // Human delay dominates the wall clock; the research itself is minutes.
  maxDuration: 1800,
  run: async (payload: PatternHunterInterviewPayload) => {
    logger.info("pattern-hunter-interview starting", {
      sessionId: payload.session_id,
      subject: payload.subject,
    });

    if (!payload.session_id?.trim()) throw new Error("session_id is required");
    if (!payload.subject?.trim()) throw new Error("subject is required");

    // This task never resolves a per-visitor identity up front — every
    // planner/extraction round below calls conversationAgentJson with no
    // lettaAgentId/lettaUserEmail, and the visitor is only bound to a
    // Conversation at the end, via patternHunterReflect (ADR 0030 Addendum,
    // point 3: Claude generates statelessly, so nothing needs identity until
    // registration). That is only safe on Claude. On Letta, an omitted
    // identity falls back to letta-fallback.ts's USER_EMAIL — the operator's
    // own agent — which would silently write every visitor's interview into
    // it. Refuse rather than let that happen quietly.
    if (resolveBackend() === "letta") {
      throw new Error(
        "pattern-hunter-interview requires the Claude backend — it defers identity to " +
          "registration (pattern-hunter-reflect), which the Letta backend cannot do (a Letta " +
          "Conversation must exist before the first turn). Set ANTHROPIC_API_KEY."
      );
    }

    const startedAt = payload.started_at ?? Date.now();
    const transcript: string[] = [`operator: ${payload.subject}`];
    const rounds: Array<RoundPlan & { answer: string }> = [];
    let timeCheckAsked = false;

    // The opening message is the only free text we get, so it seeds the
    // subject. Everything after this comes from a targeted question.
    let intake: Intake = { subject: payload.subject, ...payload.intake };

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const plan = await conversationAgentJson<RoundPlan>({
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        userPrompt: buildPlannerPrompt(intake, transcript, round),
        maxTokens: 700,
        temperature: 0.2,
      });

      const elapsed = Date.now() - startedAt;
      const overBudget = elapsed >= INTERVIEW_BUDGET_MS;

      // At the budget, ask about finishing instead of about research. Only
      // once — if they choose to keep going, stop nagging.
      const isTimeCheck = overBudget && !timeCheckAsked;
      if (isTimeCheck) timeCheckAsked = true;

      const token = await wait.createToken({ timeout: "30m" });

      logger.info("pattern-hunter-interview paused for human", {
        sessionId: payload.session_id,
        round,
        tokenId: token.id,
        kind: isTimeCheck ? "time_check" : "research",
      });

      // The frontend polls the run for this metadata, renders the question,
      // and completes `token.id` with the visitor's answer.
      const result = await wait.forToken<InterviewAnswer>(token.id);
      if (!result.ok) {
        throw new Error(`Interview question timed out at round ${round}`);
      }

      transcript.push(`agent: ${plan.value.question}`);
      transcript.push(`operator: ${result.output.answer}`);
      rounds.push({ ...plan.value, answer: result.output.answer });

      // Extract before deciding anything else — the next question depends on
      // what's still missing, and the visitor sees this land in the brief.
      const extracted = await conversationAgentJson<IntakeExtraction>({
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        userPrompt: buildExtractionPrompt(plan.value.question, result.output.answer, intake),
        maxTokens: 400,
        temperature: 0,
      });
      intake = mergeIntake(intake, extracted.value);

      // Human last: a field the visitor set by hand in the brief panel beats
      // whatever the extractor read out of their prose for the same field.
      const handEdits = Object.keys(result.output.intake_patch ?? {});
      if (handEdits.length > 0) {
        intake = mergeIntake(intake, result.output.intake_patch as IntakeExtraction);
        transcript.push(`operator (corrected the brief): ${handEdits.join(", ")}`);
      }

      logger.info("pattern-hunter-interview intake updated", {
        sessionId: payload.session_id,
        round,
        handEdits,
        missing: missingIntakeFields(intake),
      });

      if (result.output.intent === "generate_now") break;
    }

    // Everything below is parameterised from the intake the interview
    // gathered — the same fields the old form collected, just asked for
    // conversationally. Risk tolerance and horizon ride along as focus areas
    // because that's the only slot patternHunterFullRun exposes for them.
    const missing = missingIntakeFields(intake);
    if (missing.length > 0) {
      logger.warn("pattern-hunter-interview running with incomplete intake", {
        sessionId: payload.session_id,
        missing,
      });
    }

    const full = await patternHunterFullRun
      .triggerAndWait({
        business_input: intake.subject ?? payload.subject,
        industry: intake.industry ?? intake.subject ?? payload.subject,
        persona: {
          role: intake.role ?? "Operator",
          concerns: [intake.primary_constraint, ...(intake.concerns ?? [])].filter(
            (c): c is string => Boolean(c)
          ),
          focus_areas: [
            ...(intake.focus_areas ?? []),
            intake.risk_tolerance ? `risk:${intake.risk_tolerance}` : undefined,
            intake.horizon_days ? `horizon_days:${intake.horizon_days}` : undefined,
          ].filter((f): f is string => Boolean(f)),
          reference_urls: intake.reference_urls ?? [],
        },
      })
      .unwrap();

    // Hand the finished session to Letta so it lands in the Conversation that
    // owns this person's identity. Claude generates statelessly, so this is the
    // only thing that records the session anywhere durable. Failing here must
    // not lose the report the visitor is waiting on — the run already
    // succeeded — so the outcome is reported rather than thrown.
    let reflection: { written: boolean; reason?: string; error?: string } = {
      written: false,
      reason: "not_attempted",
    };
    if (payload.conversation_id) {
      const reflected = await patternHunterReflect.triggerAndWait({
        session_id: payload.session_id,
        conversation_id: payload.conversation_id,
        intake,
        turns: transcript.map((line) => ({
          role: line.startsWith("operator") ? ("user" as const) : ("agent" as const),
          text: line.replace(/^(operator|agent)[^:]*:\s*/, ""),
        })),
        enabled: payload.ingest_to_letta !== false,
      });
      reflection = reflected.ok
        ? { written: reflected.output.written, reason: reflected.output.reason }
        : { written: false, error: formatTaskError(reflected.error) };
      if (!reflected.ok) {
        logger.error("pattern-hunter-interview could not write the session back", {
          sessionId: payload.session_id,
          error: reflection.error,
        });
      }
    } else {
      logger.warn("pattern-hunter-interview has no conversation_id — session not recorded", {
        sessionId: payload.session_id,
      });
      reflection = { written: false, reason: "no_conversation_id" };
    }

    return {
      session_id: payload.session_id,
      intake,
      rounds,
      duration_ms: Date.now() - startedAt,
      report: full.report,
      reflection,
    };
  },
});
