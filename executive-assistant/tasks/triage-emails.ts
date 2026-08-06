import { task, logger } from "@trigger.dev/sdk";
import { triageEmailBatch } from "../lib/gateway-llm.js";
import type { EmailBatch } from "./fetch-emails.js";

export type TriageResult = {
  email_id: string;
  sender: string;
  subject: string;
  category: string;
  proposed_action: "archive" | "label" | "delete" | "keep";
  one_line_summary: string;
  confidence: number;
};

export type TriageEmailsPayload = {
  emails: EmailBatch["emails"];
};

export const triageEmails = task({
  id: "triage-emails",
  retry: { maxAttempts: 3 },
  run: async (payload: TriageEmailsPayload): Promise<TriageResult[]> => {
    logger.info("starting triage-emails");
    // Batch-level, not per-email: the Letta fallback is one stateful
    // conversation whose whole history replays each turn, so it needs the
    // inbox in a single request. gateway-llm still drives the gateway one
    // email at a time -- see triageEmailBatch's docstring.
    const verdicts = await triageEmailBatch(
      payload.emails.map((email) => ({
        sender: email.sender ?? "",
        subject: email.subject,
        snippet: email.snippet,
      }))
    );
    return payload.emails.map((email, i) => {
      const verdict = verdicts[i];
      return {
        email_id: email.id,
        sender: email.sender ?? "",
        subject: email.subject,
        category: verdict?.category ?? "Internal",
        proposed_action: verdict?.proposed_action ?? "keep",
        one_line_summary: verdict?.one_line_summary ?? "Unable to triage",
        confidence: verdict?.confidence ?? 0,
      };
    });
  
    logger.info("completed triage-emails");
  },
});
