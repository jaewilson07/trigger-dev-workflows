import { task, metadata, logger } from "@trigger.dev/sdk";
import { postPatternHunter } from "../lib/pattern-hunter-client.js";
import type { IndustrySnapshot, Usage } from "./pattern-hunter-context-snapshot.js";
import type { EvidenceResult, PatternHunterStep } from "../lib/pattern-hunter-types.js";
import { assertStepFitsMetadataBudget, forMetadata } from "../lib/pattern-hunter-types.js";

/** Mirrors Pattern Hunter's `PainPointCategory` literal union. */
export type PainPointCategory =
  | "cash-flow bottleneck"
  | "asset utilization gap"
  | "hiring nightmare"
  | "customer acquisition friction"
  | "compliance exposure";

/** Mirrors Pattern Hunter's `PainPoint`. */
export type PainPoint = {
  rank: number;
  category: PainPointCategory;
  pain_point: string;
  illustrative_quotes: string[];
};

/** Mirrors Pattern Hunter's `EvidenceSource` — the grounding sources fetched
 * via mdrag search-providers, each with a stable `ev-N` id. */
export type EvidenceSource = {
  id: string;
  title: string;
  url: string;
  snippet: string;
};

export type PatternHunterPainPointsPayload = {
  business_input: string;
  industry_snapshot?: IndustrySnapshot;
};

/** Mirrors Pattern Hunter's `PainPointsResponse` (Node 2), PLUS `step`
 * (datacrew#332) — see `ContextSnapshotResult`'s doc comment in
 * `pattern-hunter-context-snapshot.ts` for why every Pattern Hunter task
 * result now carries one.
 *
 * datacrew#334: Pattern Hunter now runs a company-level search alongside the
 * original industry-level one and returns both as separately identifiable
 * lists. `evidence_sources` is unchanged/backward-compatible — it's still
 * the full combined list (`company_evidence_sources +
 * industry_evidence_sources`, in that order, same ids) — so existing code
 * reading only `evidence_sources` (this file's own `buildEvidenceItems`,
 * which #332 moved here from `pattern-hunter-full-run.ts`) keeps working
 * unmodified. */
export type PainPointsResult = {
  status: string;
  business_input: string;
  pain_points: PainPoint[];
  quotes_disclaimer: string;
  evidence_sources: EvidenceSource[];
  /** datacrew#334: the subset of evidence_sources about the company itself
   * (never fed through the Pattern Scraper's pain-point Letta reasoning). May
   * legitimately be `[]` — see `company_evidence_found`. */
  company_evidence_sources: EvidenceSource[];
  /** datacrew#334: the subset of evidence_sources that grounds pain_points
   * — same site:reddit.com/site:glassdoor.com retrieval as before #334. May
   * legitimately be `[]` — see `industry_evidence_found`. */
  industry_evidence_sources: EvidenceSource[];
  /** datacrew#334: whether the company-level search found anything at all
   * (`company_evidence_sources.length > 0`). `false` is a legitimate "no
   * company-specific web presence found" outcome, NOT an error — Pattern
   * Hunter only 502s `/pain-points` when BOTH company and industry evidence
   * come back empty. A small/obscure business may genuinely have none here
   * while `industry_evidence_found` is still `true`. */
  company_evidence_found: boolean;
  /** datacrew#334: same as `company_evidence_found`, for
   * `industry_evidence_sources`. `false` means pain_points had nothing real
   * to ground on, which may itself surface as an empty pain_points list or
   * a downstream 502 (unrelated to this flag). */
  industry_evidence_found: boolean;
  usage: Usage;
  step: PatternHunterStep;
};

/** Derives a short source label from a URL's hostname, e.g.
 * `"https://www.reddit.com/r/..."` -> `"reddit.com"`. Falls back to the raw
 * URL (or a placeholder) if it doesn't parse — evidence_sources' `url` comes
 * from a live SearXNG search result, not a validated input, so a malformed
 * URL is plausible and must not crash the mapping. Moved here from
 * `pattern-hunter-full-run.ts` (datacrew#332) along with the rest of this
 * step's item-mapping logic — see this file's `patternHunterPainPoints`
 * task for why step construction now lives with the task that owns the
 * data it's built from. */
function deriveSourceName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.trim() || "unknown source";
  }
}

/**
 * Best-effort derivation of which pain-point category(ies) cite a given
 * evidence source, by checking whether the source's snippet and a pain
 * point's illustrative_quote overlap as substrings (case-insensitive).
 *
 * JUDGMENT CALL (flagged in the issue as "your call"): Pattern Hunter's
 * `PainPoint` schema has NO explicit evidence-source-id field —
 * `illustrative_quotes` are copied verbatim (or "lightly trimmed for
 * length," per `PAIN_POINT_SCRAPER_PERSONA` in `main.py`) from a source's
 * `snippet` by the Letta agent, but the two are never explicitly linked by
 * id server-side. Substring containment (checked both directions, to
 * tolerate either the quote or the snippet being the trimmed one) is the
 * closest available signal without changing Pattern Hunter's own response
 * contract. This under-matches when the model paraphrased more than
 * lightly — that's why this returns `undefined` (tags omitted entirely)
 * rather than a guess when nothing matches, per the resolved design ("...if
 * determinable — otherwise omit tags").
 */
function deriveEvidenceTags(source: EvidenceSource, painPoints: PainPoint[]): string[] | undefined {
  const snippet = source.snippet.trim().toLowerCase();
  if (!snippet) return undefined;

  const categories = new Set<string>();
  for (const pp of painPoints) {
    for (const quote of pp.illustrative_quotes) {
      const q = quote.trim().toLowerCase();
      if (q && (snippet.includes(q) || q.includes(snippet))) {
        categories.add(pp.category);
        break;
      }
    }
  }
  return categories.size > 0 ? Array.from(categories) : undefined;
}

/** Maps `evidence_sources` onto real `EvidenceResult` items — see
 * `pattern-hunter-full-run.ts`'s docstring ("why only steps 2 and 5 get real
 * items") for why this is a genuine, natural mapping (evidence_sources ARE
 * things found on the internet) rather than a forced one. Takes just the two
 * fields it needs (not the whole `PainPointsResult`) so it can be called
 * before `step` exists on the response object. */
function buildEvidenceItems(
  businessInput: string,
  result: { pain_points: PainPoint[]; evidence_sources: EvidenceSource[] }
): EvidenceResult[] {
  return result.evidence_sources.map((src) => {
    const tags = deriveEvidenceTags(src, result.pain_points);
    return {
      type: "evidence" as const,
      id: src.id,
      headline: src.title,
      quote: src.snippet,
      source_name: deriveSourceName(src.url),
      source_url: src.url,
      relevance: `Cited operator pain-point evidence for ${businessInput}`,
      ...(tags ? { tags } : {}),
    };
  });
}

export const patternHunterPainPoints = task({
  id: "pattern-hunter-pain-points",
  // Node 2 calls mdrag search-providers (twice, concurrently, per query set)
  // BEFORE the Letta call. datacrew#334: a transient failure confined to ONE
  // side (company or industry) no longer surfaces as a 502 — it degrades to
  // that side's evidence coming back empty (see company_evidence_found /
  // industry_evidence_found above). Only a failure hitting BOTH sides at
  // once still surfaces as this endpoint's 502. Retrying the whole step
  // re-runs every query regardless, which is safe (search-providers is a
  // read, not a mutation).
  retry: { maxAttempts: 2 },
  run: async (payload: PatternHunterPainPointsPayload): Promise<PainPointsResult> => {
    logger.info("starting pattern-hunter-pain-points");
    const start = Date.now();
    const response = await postPatternHunter<Omit<PainPointsResult, "step">>("pain-points", {
      business_input: payload.business_input,
      industry_snapshot: payload.industry_snapshot ?? null,
    });

    const items = buildEvidenceItems(payload.business_input, response);
    const step: PatternHunterStep = {
      step: 2,
      label: "Pattern Scraper",
      summary: `${response.pain_points.length} operator pain points found, ${response.evidence_sources.length} evidence sources cited`,
      status: "done",
      items,
      duration_ms: Date.now() - start,
    };

    // datacrew#332: push into the ROOT run's live metadata — see
    // `ContextSnapshotResult`'s equivalent call for why `.root`, not
    // `metadata.set`. This is the largest of the 5 steps by far (up to
    // MAX_GROUNDING_SOURCES=15 evidence items) — see
    // MAX_STEP_METADATA_BYTES's doc comment in lib/pattern-hunter-types.ts
    // for the measured real-world size this budget is calibrated against.
    assertStepFitsMetadataBudget(step);
    metadata.root
      .set("generated_at", new Date().toISOString())
      .append("steps", forMetadata(step));

    logger.info("completed pattern-hunter-pain-points");

    return { ...response, step };
  },
});
