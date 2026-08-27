import { task, logger } from "@trigger.dev/sdk";

/**
 * Fetches the top Domo-related job matches from the job-search Python API.
 *
 * This is a RESEARCH-side task called by `brief-research.ts` alongside
 * fetch-emails and search-topics. It hits `GET {JOB_SEARCH_API_URL}/top-jobs`
 * which queries the SQLite store for jobs mentioning "domo" in the title or
 * description, ranked by L3 relevance score.
 *
 * FAILURE IS NON-FATAL: if the API is down, returns an empty list rather than
 * throwing. The morning brief should still go out with email + topics even
 * when job listings are unavailable — a missing section is better than a
 * missing brief.
 */
export type JobListing = {
  title: string;
  company: string;
  location: string;
  is_remote: boolean;
  relevance: number;
  summary: string;
  why_match: string;
  url: string;
};

export type FetchJobListingsResult = {
  jobs: JobListing[];
  count: number;
};

export const fetchJobListings = task({
  id: "fetch-job-listings",
  retry: { maxAttempts: 2 },
  run: async (): Promise<FetchJobListingsResult> => {
    const apiUrl = process.env.JOB_SEARCH_API_URL ?? "http://localhost:8091";
    logger.info("starting fetch-job-listings", { apiUrl });

    try {
      const res = await fetch(`${apiUrl}/top-jobs?limit=5`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        throw new Error(`top-jobs endpoint returned ${res.status}`);
      }
      const data = (await res.json()) as { jobs: JobListing[]; count: number };
      logger.info("completed fetch-job-listings", { count: data.count });
      return data;
    } catch (err) {
      logger.error("job-search API not reachable for top-jobs", {
        apiUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal: return empty so the brief still goes out.
      return { jobs: [], count: 0 };
    }
  },
});
