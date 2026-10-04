/**
 * Typed writer for learn-mode state Annotations (`POST /api/v1/ingest/annotation`).
 *
 * ## Why this is not `learn-vault.ts`
 *
 * `learn-vault.ts` writes the learn *workspace* — served, printable HTML under
 * `/api/v1/learn/{slug}/*`. Per ADR-0045 those files are RENDERINGS. The
 * records themselves are Annotations in the Conversation's Collection, which
 * is what this module writes. Losing the workspace loses formatting; losing
 * the Collection loses the learner's history.
 *
 * So: a lesson the learner reads goes through `learn-vault.ts`. Anything a
 * LATER STAGE has to read back — the mission, what the learner already knows,
 * which sources cleared the trust gate — goes through here.
 *
 * ## The three shaped kinds
 *
 * mdrag validates these three `kind`s against a Pydantic schema
 * (`capabilities/second_brain/annotation_kinds.py`) and rejects a bad payload
 * with a 422. The types below mirror that registry deliberately: the schema is
 * enforced server-side regardless, and having it wrong here just means finding
 * out one network round-trip later instead of at `tsc`.
 *
 * **Keep them in sync.** If a field is added there and not here, this client
 * silently stops writing it — the payload passes validation (extra keys are
 * allowed, missing optional keys default) and the consumer reads a default it
 * did not expect. That failure is quiet, so treat the Python registry as the
 * source of truth and mirror changes in the same PR.
 *
 * ## Auth
 *
 * Same credential and header as `learn-vault.ts` and `mdrag-primitives.ts`:
 * `DATACREW_API_TOKEN` as `X-DC-Token`, because `wiki.datacrew.space` sits
 * behind Cloudflare Access and CF Access strips `Authorization`.
 */

import { resolveDatacrewToken } from "./datacrew-token.js";

const MDRAG_URL = (process.env.MDRAG_URL ?? "https://wiki.datacrew.space").replace(/\/+$/, "");

/** A document write, not an LLM call — same budget as `learn-vault.ts`. */
const ANNOTATION_TIMEOUT_MS = 120_000;

export class LearnAnnotationError extends Error {
  constructor(
    message: string,
    public readonly kind: string,
    public readonly status: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = "LearnAnnotationError";
  }
}

// ---------------------------------------------------------------------------
// Payload shapes — mirror `annotation_kinds.py`'s registry
// ---------------------------------------------------------------------------

/** `learn_mission` — why the learner is here. Read by every later stage. */
export type LearnMissionPayload = {
  /** The subject as the learner named it. */
  topic: string;
  /** What they want to be able to DO. Lesson difficulty keys off this, not `topic`. */
  goal: string;
  motivation?: string;
  /** Empty is legitimate — a learner who can't yet articulate success is normal. */
  success_criteria?: string[];
  constraints?: string;
};

export type AssessmentEvidence = {
  question: string;
  answer: string;
  /** `unanswered` is distinct from `incorrect` — a skipped question is not a wrong one. */
  verdict: "correct" | "partial" | "incorrect" | "unanswered";
  concept?: string;
};

/** `learn_assessment` — what the learner knows. Read by lesson authoring to set difficulty. */
export type LearnAssessmentPayload = {
  topic: string;
  level: "novice" | "beginner" | "intermediate" | "advanced";
  /** Concepts the learner DEMONSTRATED, not merely claimed. */
  known?: string[];
  /** Concepts absent. Filled by presenting material. */
  gaps?: string[];
  /**
   * Things the learner believes that are wrong. Kept separate from `gaps` on
   * purpose — a misconception has to be surfaced and contradicted first, or
   * new material gets absorbed into the wrong model.
   */
  misconceptions?: string[];
  evidence?: AssessmentEvidence[];
  /** Defaults to `low` server-side: an unevidenced placement shouldn't look settled. */
  confidence?: "low" | "medium" | "high";
};

/** `learn_resource` — one source, judged. Written per resource by the hunt. */
export type LearnResourcePayload = {
  url: string;
  title?: string;
  /** `unverified` = the gate didn't run or couldn't decide. Distinct from a real `rejected`. */
  verdict: "trusted" | "rejected" | "unverified";
  rationale?: string;
  resource_class?: "knowledge" | "wisdom";
  covers?: string[];
  /** What this source does NOT cover — drives the next hunt's queries. */
  gaps?: string[];
};

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * An `annotates` entry: a bare subject `document_uid`, or a citation carrying
 * the passage that backs the claim (ADR-0042 `Annotation_Support`).
 *
 * Populate `quotation` whenever the exact passage is in hand. A bare uid says
 * "this relates to that document"; a quotation says which sentence backs the
 * claim, which is what makes the record checkable later without re-reading the
 * whole source. Never paraphrase into it.
 */
export type AnnotationSubject =
  | string
  | {
      document_uid: string;
      quotation?: string;
      locator?: string;
      polarity?: "supports" | "invalidates";
    };

export type AnnotationResponse = {
  status: string;
  document_uid: string;
  source_url: string;
  kind: string;
  annotates: unknown[];
  provenance: string;
};

type WriteArgs<TPayload> = {
  payload: TPayload;
  /** The Collection this belongs to — a learn Conversation is scoped to one (ADR-0015). */
  collectionId: string;
  /** Zero, one, or several. `[]` is a legitimate ungrounded Annotation (ADR-0017). */
  annotates?: AnnotationSubject[];
  /** Markdown body. What a human or `query_rag` sees; the payload is what code reads. */
  content?: string;
  sourceTitle?: string;
  /**
   * Omit for append-only (safe default: a naive rerun can never clobber a
   * prior record). Pass a stable key for "rerun replaces" — which is what the
   * mission and the running assessment want, since there should be exactly one
   * of each per learn session rather than a pile of near-duplicates.
   */
  idempotencyKey?: string;
  /** Exact model id when `provenance` is `ai_assisted`, so the record is re-derivable. */
  annotatorVersion: string;
  annotatorId?: string;
  provenance?: "reproducible" | "ai_assisted" | "human";
};

async function writeAnnotation<TPayload>(
  kind: string,
  args: WriteArgs<TPayload>
): Promise<AnnotationResponse> {
  const token = resolveDatacrewToken();
  if (!token) {
    throw new Error(
      "learn-annotations needs DATACREW_API_TOKEN; it is in trigger.config.ts's " +
        "SYNCED_SECRETS, so an empty value means the Infisical sync failed"
    );
  }

  const body = {
    kind,
    payload: args.payload,
    annotates: args.annotates ?? [],
    provenance: args.provenance ?? "ai_assisted",
    annotator_id: args.annotatorId ?? "learn-workflow",
    annotator_version: args.annotatorVersion,
    content: args.content ?? "",
    source_title: args.sourceTitle,
    idempotency_key: args.idempotencyKey,
    collection_id: args.collectionId,
  };

  const res = await fetch(`${MDRAG_URL}/api/v1/ingest/annotation`, {
    method: "POST",
    headers: { "X-DC-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ANNOTATION_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    // A 422 on a shaped kind is a payload-schema failure and names the exact
    // fields (ADR-0045) — surfaced verbatim rather than flattened, because
    // that detail is the whole point of validating server-side.
    throw new LearnAnnotationError(
      `create_annotation kind=${kind} failed: ${res.status}`,
      kind,
      res.status,
      text.slice(0, 800)
    );
  }
  return JSON.parse(text) as AnnotationResponse;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * One mission per learn session, so this upserts on `mission:<slug>` rather
 * than appending. A learner refining "what am I actually trying to learn"
 * mid-session should end with one mission, not five.
 */
export async function writeMissionAnnotation(
  slug: string,
  args: WriteArgs<LearnMissionPayload>
): Promise<AnnotationResponse> {
  return writeAnnotation("learn_mission", {
    sourceTitle: `Mission — ${args.payload.topic}`,
    idempotencyKey: `mission:${slug}`,
    content: missionMarkdown(args.payload),
    ...args,
  });
}

/**
 * One *current* assessment per session, upserted on `assessment:<slug>`.
 *
 * The learner's knowledge is a moving target, and what lesson authoring needs
 * is the current picture, not an archive of every intermediate guess. Pass an
 * explicit `idempotencyKey` to override — e.g. to keep a per-topic assessment
 * when one session spans several topics.
 */
export async function writeAssessmentAnnotation(
  slug: string,
  args: WriteArgs<LearnAssessmentPayload>
): Promise<AnnotationResponse> {
  return writeAnnotation("learn_assessment", {
    sourceTitle: `Assessment — ${args.payload.topic}`,
    idempotencyKey: `assessment:${slug}`,
    content: assessmentMarkdown(args.payload),
    ...args,
  });
}

/**
 * One annotation per resource, upserted on the resource's URL.
 *
 * Re-judging a URL a later hunt turns up again should replace the earlier
 * verdict, not stack a second one — and a `rejected` verdict is kept, not
 * discarded, so the next hunt doesn't re-fetch and re-reject the same page.
 *
 * Pass `annotates: [harvestedDocumentUid]` when the source has been harvested
 * into the Collection: the payload records the verdict, the edge records the
 * subject.
 */
export async function writeResourceAnnotation(
  slug: string,
  args: WriteArgs<LearnResourcePayload>
): Promise<AnnotationResponse> {
  return writeAnnotation("learn_resource", {
    sourceTitle: `Resource — ${args.payload.title || args.payload.url}`,
    idempotencyKey: `resource:${slug}:${args.payload.url}`,
    content: resourceMarkdown(args.payload),
    ...args,
  });
}

// ---------------------------------------------------------------------------
// Markdown bodies
// ---------------------------------------------------------------------------
//
// The `payload` is what code reads; `content` is what a HUMAN and `query_rag`
// read. Both matter: an Annotation whose content is empty is retrievable only
// by its title, which defeats the point of putting learn state somewhere
// searchable. These render the payload rather than restating it, so the two
// can't drift.

function bullets(label: string, items: string[] | undefined): string {
  if (!items?.length) return "";
  return `\n**${label}**\n\n${items.map((i) => `- ${i}`).join("\n")}\n`;
}

export function missionMarkdown(p: LearnMissionPayload): string {
  return [
    `# Mission — ${p.topic}`,
    ``,
    `**Goal:** ${p.goal}`,
    ...(p.motivation ? [`\n**Why now:** ${p.motivation}`] : []),
    ...(p.constraints ? [`\n**Constraints:** ${p.constraints}`] : []),
    ...(p.success_criteria?.length ? [bullets("Success criteria", p.success_criteria)] : []),
  ].join("\n");
}

export function assessmentMarkdown(p: LearnAssessmentPayload): string {
  const evidence = p.evidence?.length
    ? `\n**Evidence**\n\n${p.evidence
        .map((e) => `- _${e.question}_ → "${e.answer}" (**${e.verdict}**)`)
        .join("\n")}\n`
    : "";
  return [
    `# Assessment — ${p.topic}`,
    ``,
    `**Level:** ${p.level}  |  **Confidence:** ${p.confidence ?? "low"}`,
    ...(p.known?.length ? [bullets("Knows", p.known)] : []),
    ...(p.gaps?.length ? [bullets("Gaps", p.gaps)] : []),
    ...(p.misconceptions?.length
      ? [bullets("Misconceptions — teach by contradiction", p.misconceptions)]
      : []),
    ...(evidence ? [evidence] : []),
  ].join("\n");
}

export function resourceMarkdown(p: LearnResourcePayload): string {
  return [
    `# ${p.title || p.url}`,
    ``,
    `**Verdict:** ${p.verdict}${p.resource_class ? ` (${p.resource_class})` : ""}`,
    ``,
    `<${p.url}>`,
    ...(p.rationale ? [`\n${p.rationale}`] : []),
    ...(p.covers?.length ? [bullets("Covers", p.covers)] : []),
    ...(p.gaps?.length ? [bullets("Does not cover", p.gaps)] : []),
  ].join("\n");
}
