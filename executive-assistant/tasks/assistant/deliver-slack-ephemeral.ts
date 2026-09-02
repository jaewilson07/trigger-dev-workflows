import { task, logger } from "@trigger.dev/sdk";

/**
 * Slack `response_url` delivery — the ephemeral reply to a slash command.
 *
 * WHY THIS IS NOT `post-slack`. `post-slack` calls `chat.postMessage` with
 * `DATACREW_SLACK_BOT_TOKEN` against a fixed channel: a broadcast, visible to
 * everyone in it, addressed by channel id. A `response_url` is the opposite —
 * unauthenticated (the URL itself is the capability), scoped to the one
 * interaction that produced it, visible only to the invoking user, and valid
 * for 30 minutes and 5 uses. Routing one through the other would mean either
 * posting a user's private inbox summary into a shared channel or teaching the
 * generic primitive a second auth model.
 *
 * WHY IT IS A TASK RATHER THAN THE INLINE `fetch` IT REPLACED. Three reasons,
 * all of which the inline version got wrong:
 *
 * 1. NO RETRY. The inline `fetch` in `email-digest.ts` had none, while
 *    `post-slack` retries 3x — so the least reliable Slack call in the repo was
 *    the only one with no protection. Retry here is safe: Slack allows 5 uses
 *    of a `response_url`, and a duplicate ephemeral reply is strictly better
 *    than a summary the user never sees.
 * 2. A FAILED REPLY THREW OUT OF THE ORCHESTRATOR, discarding a digest that had
 *    already been fetched, triaged and synthesized. Now it is one destination
 *    among several and its failure is reported, not fatal.
 * 3. IT COULD NOT BE COMPOSED. `/email-summary --to-drive` meant editing the
 *    orchestrator; now it is an added entry in `email-digest-deliver`'s batch.
 *
 * `response_type` is a payload field rather than a constant because the SAME
 * URL serves both — `ephemeral` (only the invoker sees it, the right default
 * for someone's inbox) and `in_channel` (everyone sees it). Making it explicit
 * keeps a future "share this digest" from needing a second task.
 */

export type DeliverSlackEphemeralPayload = {
  /** Slack's per-interaction callback URL. Expires 30 minutes after the command. */
  responseUrl: string;
  text: string;
  /** Defaults to `ephemeral` — only the invoking user sees the reply. */
  responseType?: "ephemeral" | "in_channel";
  /** `false` returns `skipped` without posting. */
  enabled?: boolean;
};

export type SlackEphemeralOutcome =
  | { destination: "slack-ephemeral"; status: "delivered"; responseType: string; chars: number }
  | { destination: "slack-ephemeral"; status: "skipped"; reason: string };

export const deliverSlackEphemeral = task({
  id: "deliver-slack-ephemeral",
  // The retry `email-digest`'s inline fetch never had. See above for why
  // re-posting is safe.
  retry: { maxAttempts: 3 },
  run: async (payload: DeliverSlackEphemeralPayload): Promise<SlackEphemeralOutcome> => {
    logger.info("starting deliver-slack-ephemeral");
    if (payload.enabled === false) {
      return { destination: "slack-ephemeral", status: "skipped", reason: "disabled by caller" };
    }
    if (!payload.responseUrl) {
      return { destination: "slack-ephemeral", status: "skipped", reason: "no responseUrl on the payload" };
    }

    const responseType = payload.responseType ?? "ephemeral";
    const res = await fetch(payload.responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: responseType, text: payload.text }),
      signal: AbortSignal.timeout(15_000),
    });

    // A genuine failure throws so Trigger.dev's retry applies; the caller
    // records the final outcome rather than dying with it.
    if (!res.ok) {
      throw new Error(`Slack response_url post failed: ${res.status} ${await res.text()}`);
    }

    logger.info("Delivered ephemeral Slack reply", { responseType, chars: payload.text.length });
    logger.info("completed deliver-slack-ephemeral", { responseType });
    return {
      destination: "slack-ephemeral",
      status: "delivered",
      responseType,
      chars: payload.text.length,
    };
  },
});
