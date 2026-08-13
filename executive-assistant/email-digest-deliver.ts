import { batch, task, logger } from "@trigger.dev/sdk";
import { deliverSlackEphemeral } from "./tasks/deliver-slack-ephemeral.js";
import { reportGDoc } from "./tasks/report-gdoc.js";
import { reportMdrag } from "./tasks/report-mdrag.js";
import type { ReportDeliveryReport, ResearchReport } from "./lib/report-delivery.js";
import type { SlackEphemeralOutcome } from "./tasks/deliver-slack-ephemeral.js";

/**
 * The OUTPUT half of `/email-summary`: reply to the invoking user, and
 * optionally file the digest in Drive — in parallel.
 *
 * WHY THIS IS ITS OWN ORCHESTRATOR AND NOT `report-deliver`. `report-deliver`
 * is typed to `ResearchReport.steps` — the structured, multi-step shape Pattern
 * Hunter and Deep Researcher produce. A digest has no steps; it has a markdown
 * body and an ephemeral URL to send it to, and its PRIMARY destination
 * (`response_url`) is one no other workflow can use, because the URL only
 * exists for the 30 minutes after a specific slash command. Forcing the digest
 * through the report seam would mean inventing a fake step list so the wrong
 * renderer could ignore it.
 *
 * What it DOES share is the vocabulary and the fan-out shape:
 * `batch.triggerByTaskAndWait`, always-two entries, `delivered | skipped |
 * failed`, and a failure in one destination that cannot take out its sibling.
 * The Drive entry reuses `report-gdoc` directly, wrapping the digest in a
 * minimal single-step `ResearchReport` — honest, because a digest genuinely is
 * one step, and it means Drive delivery has exactly one implementation here.
 *
 * The status replies (`not_connected`, `empty`) do NOT come through here: they
 * are short strings with nothing to archive, so `email-digest` sends them
 * straight to `deliver-slack-ephemeral`. Only the digest itself fans out.
 *
 * MDRAG IS THE THIRD DESTINATION, ADDED PER jaewilson07/mdrag#1034 — same
 * reuse move as Drive: `report-mdrag` (already shared by `report-deliver` for
 * Pattern Hunter/Deep Researcher) takes the same one-step `ResearchReport`
 * this file already builds for `report-gdoc`, so archiving the digest into
 * mdrag costs one batch entry, not a new implementation. `configuration`
 * records which triaged emails (count + subjects — never bodies) this
 * digest summarized, so the archived digest is queryably traceable to its
 * inputs, the same "digest is an annotation, configuration points at the
 * input articles" shape `deliver-mdrag.ts` gives the morning brief. Same
 * gating as every other `report-mdrag` caller: `skipped` without
 * `REPORT_MDRAG_COLLECTION_ID`/`MDRAG_TOKEN` configured, never a hard
 * requirement this workflow imposes on its own.
 */

export type EmailDigestDeliverPayload = {
  /** The invoking user's canonical email — also the Google identity for Drive. */
  userId: string;
  /** Slack's per-interaction callback URL. */
  responseUrl: string;
  /** The rendered digest. */
  briefMarkdown: string;
  emailCount: number;
  /**
   * Subjects of the triaged emails this digest summarized, in triage order.
   * Optional — omitted callers (or an empty array) just mean
   * `metadata.configuration.input_email_subjects` records nothing, not that
   * mdrag delivery is skipped. See `email-digest.ts`, mdrag#1034.
   */
  subjects?: string[];
  /** `YYYY-MM-DD` the digest is about. Defaults to today. */
  date?: string;
  slack?: { enabled?: boolean; responseType?: "ephemeral" | "in_channel" };
  /**
   * OFF by default, unlike every other workflow's destinations. A slash command
   * is a request for an answer in Slack, not a request to create files in
   * someone's Drive — an on-demand digest silently accumulating a document a
   * day would be a surprise. Opt in per invocation (`/email-summary --to-drive`)
   * or per deploy (EMAIL_DIGEST_GDOC_ENABLED=true).
   */
  gdoc?: { enabled?: boolean; ownerEmail?: string; folderId?: string; title?: string };
};

export type EmailDigestDeliverResult = {
  date: string;
  slack: SlackEphemeralOutcome | { destination: "slack-ephemeral"; status: "failed"; error: string };
  gdoc: ReportDeliveryReport;
  mdrag: ReportDeliveryReport;
  deliveredCount: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

export const emailDigestDeliver = task({
  id: "email-digest-deliver",
  retry: { maxAttempts: 1 },
  run: async (payload: EmailDigestDeliverPayload): Promise<EmailDigestDeliverResult> => {
    const date = payload.date ?? new Date().toISOString().slice(0, 10);
    logger.info("starting email-digest-deliver", { date, userId: payload.userId });

    // The digest as a one-step report, so `report-gdoc` needs no special case.
    const report: ResearchReport = {
      workflow: "email-digest",
      title: payload.gdoc?.title ?? `Inbox digest — ${date}`,
      subject: `${payload.emailCount} emails`,
      date,
      generated_at: new Date().toISOString(),
      status: "completed",
      steps: [
        {
          step: 1,
          label: "Inbox digest",
          summary: `${payload.emailCount} emails triaged`,
          status: "done",
          items: [],
          narrative: payload.briefMarkdown,
        },
      ],
      ownerEmail: payload.gdoc?.ownerEmail ?? payload.userId,
    };

    // Drive is opt-in — see the payload's `gdoc` doc comment. Resolved here
    // rather than inside `report-gdoc`, because "off unless asked" is this
    // workflow's policy, not the destination's.
    const gdocEnabled = payload.gdoc?.enabled ?? process.env.EMAIL_DIGEST_GDOC_ENABLED === "true";

    const {
      runs: [slackRun, gdocRun, mdragRun],
    } = await batch.triggerByTaskAndWait([
      {
        task: deliverSlackEphemeral,
        payload: {
          responseUrl: payload.responseUrl,
          text: payload.briefMarkdown,
          ...(payload.slack?.responseType ? { responseType: payload.slack.responseType } : {}),
          ...(payload.slack?.enabled === false ? { enabled: false } : {}),
        },
      },
      {
        task: reportGDoc,
        payload: {
          report,
          // The digest markdown IS the document — `report-gdoc` would otherwise
          // render the one-step report envelope around it, which for a single
          // narrative step is pure noise.
          markdown: payload.briefMarkdown,
          enabled: gdocEnabled,
          ...(payload.gdoc?.ownerEmail ? { ownerEmail: payload.gdoc.ownerEmail } : { ownerEmail: payload.userId }),
          ...(payload.gdoc?.folderId ? { folderId: payload.gdoc.folderId } : {}),
        },
      },
      {
        task: reportMdrag,
        payload: {
          report,
          markdown: payload.briefMarkdown,
          configuration: {
            input_email_count: payload.emailCount,
            input_email_subjects: payload.subjects ?? [],
          },
        },
      },
    ]);

    const slack: EmailDigestDeliverResult["slack"] = slackRun.ok
      ? (slackRun.output as SlackEphemeralOutcome)
      : { destination: "slack-ephemeral", status: "failed", error: errorMessage(slackRun.error) };

    const gdoc: ReportDeliveryReport = gdocRun.ok
      ? (gdocRun.output as ReportDeliveryReport)
      : { destination: "gdoc", status: "failed", error: errorMessage(gdocRun.error) };

    const mdrag: ReportDeliveryReport = mdragRun.ok
      ? (mdragRun.output as ReportDeliveryReport)
      : { destination: "mdrag", status: "failed", error: errorMessage(mdragRun.error) };

    const deliveredCount = [slack, gdoc, mdrag].filter((d) => d.status === "delivered").length;

    // The Slack reply is the one destination whose failure the user actually
    // experiences — they typed a command and got nothing back. Logged at error
    // even though it does not fail this task.
    if (slack.status === "failed") {
      logger.error("Email digest reply failed", { userId: payload.userId, error: slack.error });
    }
    if (gdoc.status === "failed") {
      logger.error("Email digest Drive delivery failed", { userId: payload.userId, error: gdoc.error });
    }
    if (mdrag.status === "failed") {
      logger.error("Email digest mdrag archive failed", { userId: payload.userId, error: mdrag.error });
    }

    return { date, slack, gdoc, mdrag, deliveredCount };
  },
});
