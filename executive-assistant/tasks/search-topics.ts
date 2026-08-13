import { task, logger } from "@trigger.dev/sdk";
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
    logger.info("starting search-topics");
    const result = await searchTrackedTopics(payload.topics, payload.maxResultsPerTopic ?? 5);
    logger.info("completed search-topics", {
      topicCount: result.length,
      totalResults: result.reduce((n, r) => n + r.results.length, 0),
    });
    return result;
  },
});
