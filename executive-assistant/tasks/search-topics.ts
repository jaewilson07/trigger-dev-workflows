import { task } from "@trigger.dev/sdk";
import { searchTrackedTopics } from "../lib/mdrag-topic-search.js";
import type { TopicSearchResult, TopicSearchResultItem } from "../lib/mdrag-topic-search.js";

export type { TopicSearchResult, TopicSearchResultItem };

export type SearchTopicsPayload = {
  topics: string[];
  maxResultsPerTopic?: number;
};

export const searchTopics = task({
  id: "search-topics",
  retry: { maxAttempts: 2 },
  run: async (payload: SearchTopicsPayload): Promise<TopicSearchResult[]> => {
    return searchTrackedTopics(payload.topics, payload.maxResultsPerTopic ?? 5);
  },
});
