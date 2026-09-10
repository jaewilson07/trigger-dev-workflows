import { batch, task, logger } from "@trigger.dev/sdk";
import { mdragSearchProviders, type MdragSearchHit } from "../research/mdrag-search-providers.js";
import { mdragCritique } from "../research/mdrag-critique.js";

/**
 * Find high-trust resources for a teaching mission and put them through an
 * adversarial trust gate.
 *
 * This is the phase the `/teach` skill says comes FIRST: "before the
 * RESOURCES.md is well-populated, your focus should be to find high-quality
 * resources which will help the user acquire knowledge. Never trust your
 * parametric knowledge." A chat session does it one query at a time while
 * someone waits; here it fans out and runs unattended.
 *
 * ## Two tasks, not one
 *
 * Search and vetting are separate child tasks on purpose. `create-workflow`
 * step 1: size a task by what you can afford to re-run, and never fuse an
 * expensive external fetch with the LLM step that consumes it. That is not
 * abstract here — the shared search pool is a scarce resource (roughly four
 * Pattern Hunter runs is enough to suspend it), so a failed critique must never
 * be able to re-fire the searches that fed it.
 *
 * ## Parallelization, not "an agent"
 *
 * The fan-out is a fixed list of queries decided before the run starts, so this
 * is the Parallelization workflow pattern. Nothing here chooses its own next
 * action; if it did, the whole phase would be agent-shaped and would need a
 * different set of guarantees.
 */

/** One vetted resource, ready to render into a RESOURCES document. */
export type ResourceEntry = {
  title: string;
  url: string;
  /** One line: what it covers and when to reach for it. A bare link is useless in three months. */
  annotation: string;
  /** Knowledge grounds explainers; Wisdom is where skills get tested on real people. */
  group: "knowledge" | "wisdom";
  /** The critique's own words on why this cleared the bar. */
  rationale: string;
};

export type HuntResourcesPayload = {
  /** The mission this is serving — vetting is against the mission, not the bare topic. */
  topic: string;
  /** MISSION.md, when the workspace has one. Sharpens both the queries and the gate. */
  mission?: string;
  /**
   * What is missing. In the skill's format this is RESOURCES.md's `## Gaps`
   * section, which exists precisely to "drive future search" — so an unattended
   * run reads the gaps and goes after them rather than re-covering old ground.
   */
  gaps?: string[];
  /** Cap the fan-out. Each query is one search-pool call. */
  maxQueries?: number;
  resultsPerQuery?: number;
};

export type HuntResourcesResult = {
  topic: string;
  queries: string[];
  /** Everything the searches returned, before vetting. */
  candidateCount: number;
  /** Only what cleared the trust gate. */
  resources: ResourceEntry[];
  /** Candidates the gate rejected, kept so a later run doesn't re-propose them. */
  rejected: { url: string; reason: string }[];
};

/**
 * The trust bar, taken from the skill's own RESOURCES rules: "prefer primary
 * sources, recognised experts, peer-reviewed work, and communities with strong
 * moderation. If a resource is marketing dressed as education, leave it out."
 *
 * Phrased as criteria a critique can fail a subject on. `mdragCritique` ANDs
 * them server-side into one machine-actionable `passed`, so a resource clears
 * only by clearing all three.
 */
const TRUST_CRITERIA = [
  "Is a primary source, a recognised expert, peer-reviewed work, or a strongly moderated community — not marketing dressed as education, and not SEO content farming",
  "Is directly useful for the stated mission, not merely adjacent to the topic",
  "Is specific enough to cite — a concrete article, book, course, paper or named community, not a homepage or a link roundup",
];

/**
 * Queries for one hunt. Gaps win when present: they are the explicit work queue.
 * Otherwise fall back to a spread over the topic that mirrors what the skill
 * asks for — foundations, practice, and a community for wisdom.
 */
function buildQueries(payload: HuntResourcesPayload, max: number): string[] {
  const gaps = (payload.gaps ?? []).filter(Boolean);
  if (gaps.length > 0) {
    return gaps.slice(0, max).map((gap) => `${payload.topic} ${gap}`);
  }
  return [
    `${payload.topic} definitive guide by a recognised expert`,
    `${payload.topic} peer-reviewed OR primary source`,
    `${payload.topic} practical exercises OR worked examples`,
    `${payload.topic} active community forum OR subreddit`,
  ].slice(0, max);
}

/** A community resource is Wisdom; everything else grounds Knowledge. */
function classify(hit: MdragSearchHit): "knowledge" | "wisdom" {
  const haystack = `${hit.url} ${hit.title}`.toLowerCase();
  return /reddit\.com|forum|discourse|stackexchange|stackoverflow|discord|slack|meetup|community/.test(
    haystack
  )
    ? "wisdom"
    : "knowledge";
}

export const teachHuntResources = task({
  id: "teach-hunt-resources",
  // The orchestrator does not retry this: the searches inside it have already
  // spent from the pool, and the children carry their own retries.
  retry: { maxAttempts: 1 },
  run: async (payload: HuntResourcesPayload): Promise<HuntResourcesResult> => {
    const maxQueries = payload.maxQueries ?? 4;
    const queries = buildQueries(payload, maxQueries);
    logger.info("starting teach-hunt-resources", {
      topic: payload.topic,
      queryCount: queries.length,
      drivenByGaps: (payload.gaps ?? []).length > 0,
    });

    // --- Search: fixed fan-out, one child per query ---
    const { runs } = await batch.triggerByTaskAndWait(
      queries.map((text) => ({
        task: mdragSearchProviders,
        payload: { text, limit: payload.resultsPerQuery ?? 5 },
      }))
    );

    // De-duplicate by URL across queries — overlapping queries are the point of
    // a spread, but the same source vetted twice would double-count.
    const byUrl = new Map<string, MdragSearchHit>();
    runs.forEach((run, i) => {
      if (!run.ok) {
        // One dead query does not sink the hunt; the rest still produce a
        // usable resource set, and the failure is attributable to its query.
        logger.warn("search query failed", { query: queries[i] });
        return;
      }
      for (const hit of run.output.results) {
        if (hit.url && !byUrl.has(hit.url)) byUrl.set(hit.url, hit);
      }
    });

    const candidates = [...byUrl.values()];
    if (candidates.length === 0) {
      logger.info("completed teach-hunt-resources — no candidates", { topic: payload.topic });
      return { topic: payload.topic, queries, candidateCount: 0, resources: [], rejected: [] };
    }

    // --- Trust gate: one critique over every candidate ---
    const critique = await mdragCritique
      .triggerAndWait({
        context: payload.mission
          ? `Teaching mission for "${payload.topic}":\n\n${payload.mission}`
          : `Learner is studying: ${payload.topic}`,
        criteria: TRUST_CRITERIA,
        subjects: candidates.map((hit, i) => ({
          id: String(i),
          assertion: `${hit.title} — ${hit.url}`,
          evidence: hit.snippet ? [hit.snippet] : [],
        })),
        instructions:
          "Judge each resource as a teaching source for the mission above. " +
          "Be skeptical by default: when you cannot tell whether a source is " +
          "authoritative, fail it. Five sharp sources beat thirty mediocre ones.",
      })
      .unwrap();

    const resources: ResourceEntry[] = [];
    const rejected: { url: string; reason: string }[] = [];

    for (const verdict of critique.verdicts ?? []) {
      const hit = candidates[Number(verdict.subject_id)];
      if (!hit) continue;
      if (verdict.passed) {
        resources.push({
          title: hit.title,
          url: hit.url,
          // The skill's rule: annotate every entry, one line on what it covers
          // and when to reach for it. The snippet is the honest source for that;
          // the rationale explains why it survived the gate.
          annotation: (hit.snippet ?? verdict.rationale ?? "").trim().slice(0, 300),
          group: classify(hit),
          rationale: verdict.rationale ?? "",
        });
      } else {
        rejected.push({ url: hit.url, reason: verdict.rationale || verdict.verdict });
      }
    }

    logger.info("completed teach-hunt-resources", {
      topic: payload.topic,
      candidateCount: candidates.length,
      keptCount: resources.length,
      rejectedCount: rejected.length,
    });

    return {
      topic: payload.topic,
      queries,
      candidateCount: candidates.length,
      resources,
      rejected,
    };
  },
});
