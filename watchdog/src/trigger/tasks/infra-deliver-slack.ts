import { task, logger } from "@trigger.dev/sdk";
import { buildSlackBlocks, buildSlackText } from "../../lib/infra-health.js";
import { infraSkipped } from "../../lib/infra-delivery.js";
import { fetchInfisicalSecret } from "../../lib/infisical.js";
import type { InfraHealthReport } from "../../lib/infra-health.js";
import type { InfraDeliveryOutcome } from "../../lib/infra-delivery.js";

/**
 * Slack delivery for the infra health report.
 *
 * SLACK IS A DESTINATION NOW, NOT A STEP. It used to be called from the middle
 * of the gather function, which meant you could not get the health data without
 * posting it, or post a report you had gathered earlier. This task takes an
 * `InfraHealthReport` and knows nothing about how it was gathered.
 *
 * TOKEN RESOLUTION, IN ORDER: `DATACREW_SLACK_BOT_TOKEN` from the environment
 * first, then Infisical. Env first is the change — the old code went straight
 * to Infisical on every run, so a Slack post cost two extra HTTP round trips
 * (auth + secret fetch) and failed entirely whenever Infisical was down, even
 * though the token is a perfectly ordinary environment variable that the other
 * two projects in this repo already read that way. Infisical stays as the
 * fallback so an existing deployment that has NOT set the env var keeps
 * working unchanged.
 */
export type InfraDeliverSlackPayload = {
  report: InfraHealthReport;
  /** Defaults to DATACREW_INFRA_SLACK_CHANNEL_ID. */
  channel?: string;
  /** `false` returns `skipped` without posting. */
  enabled?: boolean;
};

const DEFAULT_CHANNEL_ID = "C0BBWUSTMDZ";

async function resolveToken(): Promise<string | null> {
  const fromEnv = process.env.DATACREW_SLACK_BOT_TOKEN;
  if (fromEnv) return fromEnv;

  try {
    return await fetchInfisicalSecret("DATACREW_SLACK_BOT_TOKEN");
  } catch (error) {
    logger.warn("infra-deliver-slack: Infisical fallback failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const infraDeliverSlack = task({
  id: "infra-deliver-slack",
  retry: { maxAttempts: 3 },
  run: async (payload: InfraDeliverSlackPayload): Promise<InfraDeliveryOutcome> => {
    if (payload.enabled === false) {
      return infraSkipped("slack", "disabled by caller");
    }

    const token = await resolveToken();
    if (!token) {
      return infraSkipped(
        "slack",
        "no DATACREW_SLACK_BOT_TOKEN in the environment and Infisical could not supply one"
      );
    }

    const channel = payload.channel ?? process.env.DATACREW_INFRA_SLACK_CHANNEL_ID ?? DEFAULT_CHANNEL_ID;

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        text: buildSlackText(payload.report),
        blocks: buildSlackBlocks(payload.report),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = (await res.json()) as { ok?: boolean; error?: string; ts?: string; channel?: string };
    // A genuine Slack failure throws so the retry above applies; the delivery
    // orchestrator records the final outcome without dying with it.
    if (!res.ok || !data.ok) {
      throw new Error(`Slack post failed: ${res.status} ${data.error ?? "unknown_error"}`);
    }

    logger.info("infra-deliver-slack: posted report", {
      channel: data.channel ?? channel,
      overallStatus: payload.report.overallStatus,
    });

    return {
      destination: "slack",
      status: "delivered",
      channel: data.channel ?? channel,
      ts: data.ts ?? "",
    };
  },
});
