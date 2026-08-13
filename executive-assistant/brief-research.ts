import { task, logger } from "@trigger.dev/sdk";
import { fetchEmails } from "./tasks/fetch-emails.js";
import { triageEmails } from "./tasks/triage-emails.js";
import { searchTopics } from "./tasks/search-topics.js";
import type { BriefResearch } from "./lib/brief-delivery.js";

/**
 * The RESEARCH half of the morning brief: fetch-emails -> triage-emails ->
 * search-topics. Produces raw research data and stops there.
 *
 * Split out of `morning-brief.ts` so it is reusable: the same research feeds
 * the daily brief, and could feed a weekly digest or an on-demand run without
 * dragging Slack/Domo/Drive credentials into scope. Nothing in this file knows
 * a destination exists -- that is `brief-deliver.ts`'s job.
 *
 * It is also independently triggerable: `{}` is a valid payload, which is why
 * every field below has a fallback rather than being required.
 *
 * ORDERING. Email fetch/triage runs before topic search, as it did before the
 * split. They are independent and could be parallel, but `triageEmails` can
 * take a slow Letta fallback path (`lib/letta-fallback.ts`) and topic search
 * hits mdrag; running them sequentially keeps one failure attributable to one
 * step, and the chain is minutes long either way against a 07:00 cron.
 */

/**
 * `MORNING_BRIEF_GOOGLE_OWNER_EMAIL`, not `MORNING_BRIEF_USER_EMAIL` and not
 * `MORNING_BRIEF_USER_ID`. See morning-brief.ts's header comment: the three
 * identities for this person are not interchangeable, and passing the Slack id
 * here is what broke this chain's first step once already (400: "owner_email
 * must be a valid email address").
 */
const DEFAULT_OWNER_EMAIL = process.env.MORNING_BRIEF_GOOGLE_OWNER_EMAIL ?? "";

/**
 * The single source of truth for what the brief tracks. Lived in
 * morning-brief.ts until the research/delivery split; it moved here so a
 * standalone `brief-research` run tracks the same topics the cron does instead
 * of duplicating the list at both call sites.
 */
const DEFAULT_TOPICS = (process.env.MORNING_BRIEF_TOPICS ?? "")
  .split(",")
  .map((topic) => topic.trim())
  .filter(Boolean);

const FALLBACK_TOPICS = ["Domo acquisition", "Claude AI", "Snowflake Certification"];

export type BriefResearchPayload = {
  /** Canonical lowercased primary email. Defaults to MORNING_BRIEF_GOOGLE_OWNER_EMAIL. */
  ownerEmail?: string;
  maxEmails?: number;
  topics?: string[];
  maxResultsPerTopic?: number;
};

export const briefResearch = task({
  id: "brief-research",
  // Unchanged from the pre-split chain: the retries that matter live on the
  // three child tasks, and this orchestrator re-running would redo all of them.
  queue: { concurrencyLimit: 1 },
  run: async (payload: BriefResearchPayload): Promise<BriefResearch> => {
    logger.info("starting brief-research", { topics: payload.topics?.length ?? 0 });
    const ownerEmail = payload.ownerEmail ?? DEFAULT_OWNER_EMAIL;
    if (!ownerEmail) {
      // Loud here rather than at the auth-service call, where the same mistake
      // surfaces as an opaque 400 several frames down.
      throw new Error(
        "brief-research needs an ownerEmail: pass one in the payload or set " +
          "MORNING_BRIEF_GOOGLE_OWNER_EMAIL"
      );
    }

    const topics = payload.topics ?? (DEFAULT_TOPICS.length > 0 ? DEFAULT_TOPICS : FALLBACK_TOPICS);

    const emailBatch = await fetchEmails
      .triggerAndWait({ ownerEmail, maxResults: payload.maxEmails ?? 25 })
      .unwrap();

    const triageResults = await triageEmails
      .triggerAndWait({ emails: emailBatch.emails })
      .unwrap();

    const topicResults = await searchTopics
      .triggerAndWait({ topics, maxResultsPerTopic: payload.maxResultsPerTopic ?? 5 })
      .unwrap();

    logger.info("Research complete", {
      ownerEmail,
      emailCount: emailBatch.count,
      triageCount: triageResults.length,
      topicCount: topicResults.length,
    });

    return {
      date: new Date().toISOString().slice(0, 10),
      ownerEmail,
      emailCount: emailBatch.count,
      triageResults,
      topicResults,
      researched_at: new Date().toISOString(),
    };
  },
});
