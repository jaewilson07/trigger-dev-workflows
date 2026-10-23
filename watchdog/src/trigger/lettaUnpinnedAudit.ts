import { schedules, logger } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { fetchPaperclipAgents, runAudit } from "../lib/lettaUnpinnedAudit.js";
import type { AuditOutput } from "../lib/lettaUnpinnedAudit.js";
import { postSlackAlert } from "../lib/slackAlert.js";
import { previousRunOutput } from "./tasks/previous-run-output.js";

/**
 * Hourly, report-only: which Paperclip `letta_cloud` agents have no
 * `conversationId` pinned in `adapterConfig`. Decision logic and the why live in
 * `../lib/lettaUnpinnedAudit.ts`. Never modifies an agent.
 *
 * Scheduling follows the Trigger.dev docs bundled with the installed SDK
 * (`node_modules/@trigger.dev/sdk/docs`): a declarative `schedules.task` cron
 * is deployed with the task, and `environments: ["PRODUCTION"]` keeps dev runs off.
 *
 * Secrets, fetched at use and never logged: `PAPERCLIP_BOARD_API_KEY` from
 * Infisical `/paperclip`; Slack token via `postSlackAlert` (DATACREW_SLACK_BOT_TOKEN).
 */
export const lettaUnpinnedAudit = schedules.task({
  id: "letta-unpinned-audit",
  cron: { pattern: "17 * * * *", environments: ["PRODUCTION"] },
  maxDuration: 120,
  retry: { maxAttempts: 2 },
  run: async (): Promise<AuditOutput> => {
    logger.info("starting letta-unpinned-audit");
    const apiKey = await getSecret("PAPERCLIP_BOARD_API_KEY", { path: "/paperclip", recursive: false });
    const result = await runAudit({
      fetchAgents: () => fetchPaperclipAgents(apiKey),
      notify: postSlackAlert,
      previous: () => previousRunOutput<AuditOutput>("letta-unpinned-audit"),
      now: new Date(),
    });
    logger.info("completed letta-unpinned-audit", {
      checked: result.checked,
      unpinned: result.unpinnedIds.length,
      alerted: result.alerted,
    });
    return result;
  },
});
