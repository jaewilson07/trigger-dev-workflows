import { schedules, logger } from "@trigger.dev/sdk";
import { runClaudeAuthProbe, type ProbeRun } from "../lib/claudeAuthProbe.js";
import { ssh2Transport } from "../lib/cubbyRunJobSsh2.js";
import { postSlackAlert } from "../lib/slackAlert.js";

/**
 * Alert when prod Paperclip's Claude Code login is down or about to lapse (DAT-1999).
 *
 * Every 6 hours, asks cubby's run-job for the `paperclip-claude-auth` job (infra-baseline
 * `runbooks/paperclip-claude-auth`): `claude auth status` plus the token expiry dates inside the
 * paperclip container. Read-only, no inference, no credential ever leaves the container. Alerts to
 * Slack (#datacrew-ai) when the login is down, or when the refresh token ends within 7 days.
 * Logic and the reason for reading the dates: `../lib/claudeAuthProbe.ts`.
 *
 * Retries are OFF: a retry would only repeat the Slack post. Cubby unreachable is `skipped`.
 */
export const paperclipClaudeAuthProbe = schedules.task({
  id: "paperclip-claude-auth-probe",
  cron: { pattern: "17 */6 * * *", timezone: "America/Denver", environments: ["PRODUCTION"] },
  retry: { maxAttempts: 1 },
  maxDuration: 300,
  run: async (): Promise<ProbeRun> => {
    const result = await runClaudeAuthProbe({ transport: ssh2Transport, notify: postSlackAlert });
    if (result.status === "skipped") logger.warn("claude auth probe skipped", { reason: result.reason });
    else logger.info("claude auth probe", { verdict: result.verdict.status, alerted: result.alerted });
    return result;
  },
});
