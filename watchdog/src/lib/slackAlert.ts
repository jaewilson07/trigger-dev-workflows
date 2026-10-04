import { fetchInfisicalSecret } from "./infisical.js";

/**
 * Slack delivery for the site-monitor alerts. Same token, same default channel
 * (#datacrew-ai) and same env-first/Infisical-fallback lookup as
 * `repoMonitorReport.ts` and `infra-deliver-slack.ts`, so an alert lands where
 * the other watchdog reports already do. Unlike `repoMonitorReport`, a missing
 * token THROWS: a monitor that silently cannot alert is the failure this exists
 * to prevent.
 */

export const DEFAULT_ALERT_CHANNEL = "C0BBWUSTMDZ"; // #datacrew-ai

export type SlackPost = (text: string) => Promise<void>;

async function resolveSlackToken(): Promise<string> {
  const fromEnv = process.env.DATACREW_SLACK_BOT_TOKEN;
  if (fromEnv) return fromEnv;
  return fetchInfisicalSecret("DATACREW_SLACK_BOT_TOKEN");
}

export async function postSlackAlert(text: string): Promise<void> {
  const token = await resolveSlackToken();
  const channel = process.env.SITE_MONITOR_SLACK_CHANNEL_ID || DEFAULT_ALERT_CHANNEL;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Slack post failed: ${res.status} ${data.error ?? "unknown_error"}`);
  }
}
