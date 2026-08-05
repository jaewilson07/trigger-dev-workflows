import { task, logger } from "@trigger.dev/sdk";
import { lettaResearch, extractJson, EMMABOT_AGENT_ID } from "../lib/letta-storm.js";
import type { SynthesizedReport, VerificationReport, VerificationResult } from "../lib/storm-types.js";

export type VerifySourcesPayload = {
  topic: string;
  report: SynthesizedReport;
  /** Which subset of claims to verify (for parallel sharding). */
  shardIndex?: number;
  totalShards?: number;
};

/**
 * verify-sources — Step 5 of STORM (runs in parallel, 6 verification agents).
 *
 * Adversarial peer review: each verification agent checks a subset of claims
 * by fetching the cited source and verifying the claim matches.
 *
 * Score: confirmed (source supports the claim), corrected (source exists but
 * claim needs revision), demoted (source doesn't support the claim or is unreachable).
 *
 * If any claim fails, the orchestrator loops back to synthesize-report with
 * the corrections (the evaluator-optimizer loop pattern).
 */
export const verifySources = task({
  id: "verify-sources",
  retry: { maxAttempts: 2 },
  run: async (payload: VerifySourcesPayload): Promise<VerificationReport> => {
    const { topic, report, shardIndex = 0, totalShards = 1 } = payload;

    // Flatten all claims with their citations
    const allClaims: Array<{ claim: string; section: string; source: string; sourceName: string }> = [];
    for (const section of report.sections) {
      for (const citation of section.citations) {
        // Extract claims that reference this citation from the section content
        const claims = extractClaimsForCitation(section.content, citation.number);
        for (const claim of claims) {
          allClaims.push({
            claim,
            section: section.title,
            source: citation.source,
            sourceName: citation.sourceName,
          });
        }
      }
    }

    // Shard the claims across verification agents
    const sharded = allClaims.filter((_, i) => i % totalShards === shardIndex);

    logger.info("verify-sources: starting", {
      topic,
      shardIndex,
      totalShards,
      totalClaims: allClaims.length,
      shardedClaims: sharded.length,
    });

    if (sharded.length === 0) {
      return { results: [], allVerified: true, correctionsNeeded: [] };
    }

    const claimsDigest = sharded
      .map(
        (c, i) =>
          `[${i}] Claim: "${c.claim}"\n` +
          `Source: ${c.source || "none"}\n` +
          `Source name: ${c.sourceName || "unknown"}\n` +
          `Section: ${c.section}`
      )
      .join("\n\n");

    const verificationPrompt =
      `You are a fact-checker verifying claims in a research report on "${topic}".\n\n` +
      `For each claim below, use your web fetch tool to check the cited source. ` +
      `Determine whether the source actually supports the claim.\n\n` +
      `For each claim, assign one of these statuses:\n` +
      `- "confirmed": The source exists and supports the claim\n` +
      `- "corrected": The source exists but the claim needs revision (provide the correction)\n` +
      `- "demoted": The source doesn't support the claim, is unreachable, or doesn't exist\n\n` +
      `Claims to verify:\n\n${claimsDigest}\n\n` +
      `Format your response as a JSON array of objects with keys: claim, status, source, note, correction (only if status is "corrected").`;

    const reply = await lettaResearch(
      EMMABOT_AGENT_ID,
      "You are a rigorous fact-checker who verifies claims against their primary sources.",
      verificationPrompt
    );

    const parsed = extractJson(reply);
    let results: VerificationResult[] = [];

    if (Array.isArray(parsed)) {
      results = parsed.map(coerceVerificationResult).filter(Boolean) as VerificationResult[];
    }

    // If we couldn't parse results, mark all as unverified
    if (results.length === 0 && sharded.length > 0) {
      logger.warn("verify-sources: no parseable results, marking all as demoted", {
        shardIndex,
        replyPreview: reply.trim().slice(0, 200),
      });
      results = sharded.map((c) => ({
        claim: c.claim,
        status: "demoted" as const,
        source: c.source,
        note: "Verification agent could not parse results",
      }));
    }

    const correctionsNeeded = results.filter(
      (r) => r.status === "corrected" || r.status === "demoted"
    );

    logger.info("verify-sources: complete", {
      shardIndex,
      verified: results.filter((r) => r.status === "confirmed").length,
      corrected: results.filter((r) => r.status === "corrected").length,
      demoted: results.filter((r) => r.status === "demoted").length,
    });

    return {
      results,
      allVerified: correctionsNeeded.length === 0,
      correctionsNeeded,
    };
  },
});

/**
 * Extract claims that reference a specific citation number from section text.
 *
 * Looks for patterns like "claim text [1]" or "[1] claim text" and returns
 * the surrounding sentence/paragraph as the claim.
 */
function extractClaimsForCitation(content: string, citationNumber: number): string[] {
  const tag = `[${citationNumber}]`;
  const claims: string[] = [];

  // Split into sentences and find ones containing this citation tag
  const sentences = content.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (sentence.includes(tag)) {
      // Clean up the citation tag from the claim text
      const clean = sentence.replace(/\[\d+\]/g, "").trim();
      if (clean.length > 10) {
        claims.push(clean);
      }
    }
  }

  // If no sentence-level match, use the whole paragraph containing the tag
  if (claims.length === 0) {
    const paragraphs = content.split("\n\n");
    for (const para of paragraphs) {
      if (para.includes(tag)) {
        const clean = para.replace(/\[\d+\]/g, "").trim();
        if (clean.length > 10) {
          claims.push(clean);
        }
      }
    }
  }

  return claims;
}

function coerceVerificationResult(raw: unknown): VerificationResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.claim !== "string") return null;
  const status =
    r.status === "confirmed" || r.status === "corrected" || r.status === "demoted"
      ? r.status
      : "demoted";
  return {
    claim: r.claim,
    status,
    source: typeof r.source === "string" ? r.source : "",
    note: typeof r.note === "string" ? r.note : "",
    correction: typeof r.correction === "string" ? r.correction : undefined,
  };
}
