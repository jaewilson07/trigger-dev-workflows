import { task } from "@trigger.dev/sdk";
import { formatBrief } from "../lib/format-brief.js";
import type { TriageResult } from "./triage-emails.js";
import type { TopicSearchResult } from "./search-topics.js";

export type SynthesizeBriefPayload = {
  triageResults: TriageResult[];
  topicResults: TopicSearchResult[];
};

export const synthesizeBrief = task({
  id: "synthesize-brief",
  retry: { maxAttempts: 2 },
  run: async (payload: SynthesizeBriefPayload): Promise<string> => {
    return formatBrief(payload.triageResults, payload.topicResults);
  },
});
