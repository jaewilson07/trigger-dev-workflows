/**
 * `PatternResult` / `PatternHunterStep` / `PatternHunterReport` / `Persona` —
 * mirrored verbatim (field names, discriminants, optionality) from mdrag's
 * `frontend/types/pattern-hunter.ts` (a SEPARATE repo, not a dependency of
 * this project — same "mirror, don't import" convention
 * `lib/pattern-hunter-client.ts` and `projects/pattern-hunter/main.py` both
 * already follow for cross-repo contracts). This is the shape
 * `pattern-hunter-full-run.ts` (datacrew#302) must produce so
 * `wiki.datacrew.space/pattern-hunter` (mdrag#836/#892) can consume a real
 * run as a drop-in replacement for its current mocked fixture.
 *
 * Grounding rationale (copied from mdrag's own module docstring, since it's
 * load-bearing for how `pattern-hunter-full-run.ts` maps Pattern Hunter's
 * output onto this shape): `PatternResult` is a discriminated union because
 * an evidence item found on the internet, a gap, a recommendation, a metric,
 * and a talking point are genuinely different things. `evidence` is the only
 * variant that carries a `source_*` — it's the one found verbatim. The other
 * four are *synthesised* assertions and therefore carry `derived_from`
 * (sibling `EvidenceResult.id`s), never omitted, per the
 * typed-generation-contract principle: a synthesised value with no traceable
 * origin is un-auditable, indistinguishable from a confident guess.
 *
 * This mirror only reconstructs what `pattern-hunter-full-run.ts` actually
 * needs to construct (it populates `EvidenceResult` and `RecommendationResult`
 * only — see that file's own docstring for why the other three variants are
 * deliberately left unpopulated this pass), but the full union/step/report
 * shape is mirrored regardless so the TYPE stays a faithful drop-in contract,
 * not a narrowed one.
 *
 * ONE deliberate exception to "verbatim mirror" as of datacrew#332:
 * `PatternHunterStep.narrative` does not exist yet in mdrag's upstream type —
 * see that field's own doc comment for why it was added here first.
 *
 * Also as of datacrew#332: this file additionally hosts `WorkflowRunResult`
 * and its size-guard helper below — NOT part of the mdrag mirror, and
 * deliberately NOT Pattern-Hunter-specific (see that type's own doc comment).
 * It lives in this file, rather than a new one, per that issue's explicit
 * "single source of truth in `lib/`" acceptance criterion and because this
 * was already the one file every Pattern Hunter trigger task and the
 * orchestrator both import from.
 */

export type StepStatus = "pending" | "running" | "done" | "failed";

interface PatternResultBase {
  /** Why this matters to the specific subject/persona — never generic. */
  relevance: string;
  tags?: string[];
}

/** Something found on the internet — a news mention, a forum complaint, an
 * industry article. The "evidence" type: cite it, don't paraphrase it. */
export interface EvidenceResult extends PatternResultBase {
  type: "evidence";
  id: string;
  headline: string;
  quote?: string;
  source_name: string;
  source_url: string;
  published_at?: string; // ISO date
  sentiment?: "positive" | "neutral" | "negative";
}

/** Shared shape for the four *synthesised* (non-`evidence`) variants — see
 * module docstring above for why `derived_from` is required, not optional. */
interface SynthesizedResultBase extends PatternResultBase {
  derived_from: string[];
}

/** A gap between where the subject is and where the market/requirement/role
 * says they need to be. NOT populated by `pattern-hunter-full-run.ts` this
 * pass — see that file's docstring. */
export interface GapResult extends SynthesizedResultBase {
  type: "gap";
  area: string;
  current_state: string;
  target_state: string;
  severity: "minor" | "moderate" | "critical";
}

/** A concrete next action. Populated by `pattern-hunter-full-run.ts` from
 * Pattern Hunter's `POST /brief` `recommendations` (already grounded with
 * real `derived_from` evidence-id citations server-side). */
export interface RecommendationResult extends SynthesizedResultBase {
  type: "recommendation";
  action: string;
  cta_label?: string;
  cta_url?: string;
}

/** A metric worth tracking going forward. NOT populated by
 * `pattern-hunter-full-run.ts` this pass — see that file's docstring. */
export interface MetricResult extends SynthesizedResultBase {
  type: "metric";
  metric_name: string;
  direction: "leading" | "lagging";
}

/** One line of the synthesized opening briefing. NOT populated by
 * `pattern-hunter-full-run.ts` this pass — see that file's docstring. */
export interface TalkingPointResult extends SynthesizedResultBase {
  type: "talking_point";
  statement: string;
  references_step?: number;
}

export type PatternResult =
  | EvidenceResult
  | GapResult
  | RecommendationResult
  | MetricResult
  | TalkingPointResult;

export interface PatternHunterStep {
  step: number;
  label: string;
  /** One line shown while the step is collapsed or still running. */
  summary: string;
  status: StepStatus;
  items: PatternResult[];
  duration_ms?: number;
  error?: string;
  /**
   * Markdown prose for this step, distinct from `summary` (a one-line
   * collapsed/running label) and `items` (structured findings) — datacrew#332.
   * KNOWN, INTENTIONAL divergence from mdrag's current upstream
   * `frontend/types/pattern-hunter.ts`: as of this addition mdrag's own
   * `PatternHunterStep` has no `narrative` field. This repo's #332 spec
   * explicitly calls for adding it here first (mdrag has "nowhere to put
   * prose" today) so `/brief`'s `synthesis_narrative` — previously typed by
   * `BriefResult` but silently dropped by the orchestrator's mapping — has
   * somewhere to land, and so the future Deep Researcher workflow (#336,
   * whose steps are prose-first rather than item-list-first) can reuse the
   * exact same step shape. Mirroring this back into mdrag's own type is
   * out of scope for this PR — track separately if/when mdrag needs to
   * consume it.
   */
  narrative?: string;
}

/**
 * The intake "mini-quiz" shape. datacrew#302's KNOWN GAP: there is no input
 * source for this ANYWHERE in Pattern Hunter's backend (`main.py` has no
 * concept of a persona at all) or in #298's prior Trigger.dev work. This
 * workflow accepts it as an OPTIONAL caller-supplied field on its own payload
 * and falls back to `PLACEHOLDER_PERSONA` (see `pattern-hunter-full-run.ts`)
 * when absent. Real persona capture is the frontend intake-quiz's job — this
 * issue is scoped to the orchestration workflow only; wiring a real intake
 * flow through to this payload is follow-up work once the frontend actually
 * calls this workflow.
 */
export interface Persona {
  role: string;
  concerns: string[];
  focus_areas: string[];
  reference_urls: string[];
}

export interface PatternHunterReport {
  subject: string;
  industry: string;
  persona: Persona;
  generated_at: string; // ISO datetime
  steps: PatternHunterStep[];
}

// ---------------------------------------------------------------------------
// Run envelope (datacrew#332) — workflow-agnostic, NOT part of the mdrag
// mirror above. See this file's module docstring for why it lives here.
// ---------------------------------------------------------------------------

/**
 * The run envelope's own status — distinct from `StepStatus` (a single
 * step's status). `"pending"`/`"running"` are metadata-only: they describe a
 * run still in flight, so a subscriber reading `run.metadata` mid-run sees
 * one of these; a task's own terminal RETURN value only ever settles on
 * `"completed"` or `"failed"` (by the time anything reads a return value,
 * the run is, by definition, no longer pending or running).
 */
export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed";

/**
 * Shared run-metadata envelope (datacrew#332) — "wraps the existing step
 * list with the run-level facts a viewer needs (which workflow, the input,
 * overall status, generated-at)," per that issue's own wording. Defined ONCE
 * here and imported by every Pattern Hunter task that emits progress
 * (`tasks/pattern-hunter-*.ts`) plus the orchestrator
 * (`pattern-hunter-full-run.ts`), and — later — by whatever UI subscribes to
 * `run.metadata` to render a step-reveal view. That's the concrete AC this
 * type exists to satisfy: "a single envelope type is defined once and
 * imported by every task that emits it; no duplicated shape."
 *
 * Deliberately WORKFLOW-AGNOSTIC, not Pattern-Hunter-specific: issue #336
 * (Deep Researcher) is blocked on #332 *specifically to reuse this exact
 * shape* for its own multi-step run, with a different `workflow` name and a
 * different payload as `input`. Generic over:
 * - `TInput` — the triggering payload's shape (e.g.
 *   `PatternHunterFullRunPayload`), so `input` stays typed per call site
 *   instead of `unknown`/`any`.
 * - `TStep` — the per-step shape making up `steps`, defaulted to
 *   `PatternHunterStep` so existing Pattern Hunter call sites need no type
 *   argument. NOT hard-coded to `PatternHunterStep`: forcing every future
 *   workflow's step shape to carry `items: PatternResult[]` (mdrag's own
 *   discriminated union) would smuggle Pattern-Hunter/mdrag specificity back
 *   into a type this issue explicitly asks to be workflow-agnostic. If Deep
 *   Researcher's steps end up needing a genuinely different item shape, it
 *   supplies its own `TStep` here rather than this file growing a second
 *   variant of `PatternHunterStep`.
 *
 * Naming (per this issue's explicit "propose the name, don't assume one"
 * instruction — see mdrag's `CONTEXT.md` glossary before naming decisions
 * for the underlying rationale): kept the local/mdrag `<Thing>Result`
 * convention rather than inventing a `*Envelope` type name. mdrag's own
 * `ProviderSearchResult` entry *describes* itself in prose as "the envelope
 * returned by one Provider search," but the actual type name is still
 * `...Result`, never `...Envelope` — mdrag's glossary exists specifically to
 * prevent two names for the same concept. `WorkflowRunResult` follows that:
 * "envelope" stays a description of the SHAPE (used throughout this file's
 * comments and the issue text), never a literal type name.
 *
 * `current_step` is the one field here NOT literally named in the issue's
 * four enumerated run-level facts (workflow/input/status/generated_at) — a
 * small, optional, still workflow-agnostic addition (see
 * `publishStepStarted` in `pattern-hunter-full-run.ts`) letting a subscriber
 * see WHICH step is in flight the moment it starts, not only once `steps`
 * gains a new entry when it finishes.
 */
export interface WorkflowRunResult<TInput = unknown, TStep = PatternHunterStep> {
  /** Which workflow produced this envelope, e.g. `"pattern-hunter"` (and,
   * eventually, `"deep-researcher"`) — deliberately a plain `string`, not a
   * closed union: a closed union would need editing in this shared file for
   * every new workflow, exactly the coupling "workflow-agnostic" is meant to
   * avoid. */
  workflow: string;
  /** The triggering payload, verbatim — lets a subscriber render "what was
   * this run even asked to do" without a separate lookup. */
  input: TInput;
  status: WorkflowRunStatus;
  /** ISO timestamp this envelope snapshot was last updated (not when the
   * underlying step data was computed — see each step's own `duration_ms`
   * for that). */
  generated_at: string;
  /** 1-indexed step currently executing, set the moment it STARTS (before
   * it has an entry in `steps` below) — see `current_step`'s doc comment
   * above. Absent before the first step has started. */
  current_step?: number;
  /** Append-only as each step completes (or fails) — see
   * `WorkflowRunResult`'s own doc comment for why `TStep` isn't hard-coded
   * to `PatternHunterStep`. */
  steps: TStep[];
}

/**
 * Trigger.dev's run-metadata object has a 256KB cap shared across the WHOLE
 * envelope (`~/GitHub/trigger.dev/docs/runs/metadata.mdx`'s "Size limit"
 * section), not per-step — but a child task calling
 * `metadata.parent.append("steps", step)` has no way to read the PARENT's
 * current total serialized size first: `metadata.parent`/`metadata.root`
 * expose only mutators (`set`/`append`/`remove`/`increment`/`decrement`/
 * `stream`, confirmed against `@trigger.dev/core`'s `RunMetadataUpdater`
 * type in `node_modules` and against `runs/metadata.mdx`'s own "Parent &
 * root updates" section, which lists exactly those and nothing else) — no
 * `.get()`/`.current()` equivalent for a PARENT's metadata from inside a
 * child. Absent that read access, the only check enforceable from inside a
 * single task is THIS step's own serialized size against a fixed per-step
 * budget conservative enough that every one of the 5 steps maxing it out
 * simultaneously still leaves the whole envelope under the real 256KB cap.
 *
 * MEASURED, not guessed (datacrew#332's own AC: "a realistic run is
 * verified to stay within the limit"). A representative Pattern Hunter run —
 * 15 evidence sources (`MAX_GROUNDING_SOURCES` in `main.py`, the real cap on
 * step 2's items), 3 grounded `/brief` recommendations, and a full
 * `synthesis_narrative` — serializes to ~13.8KB total across all 5 steps
 * combined, with step 2 (by far the largest) alone at ~10.7KB. An
 * intentionally stressed version (2x longer quotes/headlines on all 15
 * evidence items) still only reaches ~16.3KB for that same step. Both are
 * roughly 5-8% of the real cap. `MAX_STEP_METADATA_BYTES` below is set to
 * 48KB — about 3x that stress-tested worst observed single-step size, so
 * genuine future growth (more evidence sources, a longer narrative) has
 * real headroom, while 5 steps all hitting the budget simultaneously
 * (5 x 48KB = 240KB) still leaves ~16KB for the envelope's own
 * workflow/input/status/generated_at fields under the 256KB cap.
 *
 * If a step's real payload ever DOES exceed this, `assertStepFitsMetadataBudget`
 * throws — per this issue's explicit "fail loudly rather than silently
 * truncating" instruction — rather than writing a step that risks silently
 * blowing the run's actual 256KB cap (which the SDK itself would then throw
 * on anyway, but only once the WHOLE envelope is already over, several
 * steps later and much harder to attribute to one cause).
 */
export const MAX_STEP_METADATA_BYTES = 48 * 1024;

/** Thrown by `assertStepFitsMetadataBudget` — see `MAX_STEP_METADATA_BYTES`'s
 * doc comment for the measured numbers and reasoning behind the budget. */
export class StepMetadataTooLargeError extends Error {
  constructor(step: { step: number; label: string }, sizeBytes: number) {
    super(
      `pattern-hunter step ${step.step} (${step.label}) metadata payload is ` +
        `${sizeBytes} bytes, over the ${MAX_STEP_METADATA_BYTES}-byte per-step ` +
        `budget (Trigger.dev's run metadata cap is 256KB total, shared across ` +
        `every step — see runs/metadata.mdx). Failing loudly instead of writing ` +
        `a step that would risk the run's real cap — see MAX_STEP_METADATA_BYTES's ` +
        `doc comment in lib/pattern-hunter-types.ts for the measured numbers this ` +
        `budget is based on.`
    );
    this.name = "StepMetadataTooLargeError";
  }
}

/**
 * Validates `step`'s own serialized size against `MAX_STEP_METADATA_BYTES`
 * before a caller appends it to run metadata (`metadata.parent.append` from
 * a task, or `metadata.append` from the orchestrator's own failure path).
 * Pure and metadata-SDK-agnostic on purpose: this file has no
 * `@trigger.dev/sdk` dependency, only `@trigger.dev/core`-shaped TYPES
 * (`PatternHunterStep` etc.) — every caller does its own
 * `metadata`/`metadata.parent` call immediately after this passes.
 */
export function assertStepFitsMetadataBudget(step: PatternHunterStep): void {
  const sizeBytes = Buffer.byteLength(JSON.stringify(step), "utf8");
  if (sizeBytes > MAX_STEP_METADATA_BYTES) {
    throw new StepMetadataTooLargeError(step, sizeBytes);
  }
}

/**
 * Trigger.dev's metadata API (`metadata.set`/`.append`/`.replace`/
 * `.parent.append`) types its value parameter as `DeserializedJson`, a
 * mapped type requiring an explicit `{[key: string]: DeserializedJson}`
 * index signature. `PatternHunterStep`/`WorkflowRunResult`/
 * `PatternHunterFullRunPayload` are `interface`-declared domain types with
 * no such signature — every field IS plain, already-JSON-serializable data
 * (confirmed by `assertStepFitsMetadataBudget`'s own `JSON.stringify`
 * call — that's exactly what a value passed here is about to become on the
 * wire), but TypeScript still refuses the structural match for a named
 * interface reference (a well-known TS friction point between nominal
 * interface types and mapped/index types, not a real runtime risk — the SDK
 * itself is, per its own docs, "currently loosely typed," accepting any
 * JSON-serializable value at runtime).
 *
 * This is a narrow, explicit escape hatch at exactly that SDK boundary —
 * used only where a value has already been shaped by this file's own types
 * (and, for a `PatternHunterStep`, already run through
 * `assertStepFitsMetadataBudget`) — not a general-purpose `any` scattered
 * through call sites.
 */
export function forMetadata<T>(value: T): any {
  return value;
}
