import { task, logger } from "@trigger.dev/sdk";
import { formatBrief } from "../lib/format-brief.js";
import type { TriageResult } from "./triage-emails.js";
import type { JobListing } from "./fetch-job-listings.js";
import type { TopicSearchResult } from "./search-topics.js";

export type SynthesizeBriefPayload = {
  triageResults: TriageResult[];
  topicResults: TopicSearchResult[];
  jobListings: JobListing[];
};

export const synthesizeBrief = task({
  id: "synthesize-brief",
  retry: { maxAttempts: 2 },
  run: async (payload: SynthesizeBriefPayload): Promise<string> => {
    logger.info("starting synthesize-brief");
    const result = formatBrief(payload.triageResults, payload.topicResults, payload.jobListings);
    logger.info("completed synthesize-brief", { briefLength: result.length });
    return result;
  },
});
