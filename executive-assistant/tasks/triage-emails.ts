import { task } from "@trigger.dev/sdk";
import { triageOneEmail } from "../lib/gateway-llm.js";
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
    const results: TriageResult[] = [];
    for (const email of payload.emails) {
      const verdict = await triageOneEmail({
        sender: email.sender ?? "",
        subject: email.subject,
        snippet: email.snippet,
      });
      results.push({
        email_id: email.id,
        sender: email.sender ?? "",
        subject: email.subject,
        category: verdict.category,
        proposed_action: verdict.proposed_action,
        one_line_summary: verdict.one_line_summary,
        confidence: verdict.confidence,
      });
    }
    return results;
  },
});
