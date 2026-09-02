import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { task, logger } from "@trigger.dev/sdk";

const LOG_PATH = process.env.BRIEF_ACTIVITY_LOG_PATH ?? "../data/brief-activity.jsonl";

export type LogActivityPayload = {
  date: string;
  emailCount: number;
  topicCount: number;
  slackTs: string | null;
  pipelineDurationMs: number;
};

export const logActivity = task({
  id: "log-activity",
  run: async (payload: LogActivityPayload): Promise<void> => {
    logger.info("starting log-activity");
    const entry = {
      ...payload,
      logged_at: new Date().toISOString(),
    };

    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`);

    logger.info("Logged morning brief activity", entry);
  
    logger.info("completed log-activity");
  },
});
