/**
 * Backlog-zero gate: wake ProjectManager's sweep only when Paperclip has open
 * tasks with no owner (DAT-1563).
 *
 * A Paperclip routine's schedule trigger always wakes its agent, and every
 * wake spends model tokens, even on a day with nothing to sweep. So the
 * routine has only a webhook trigger, and this task decides whether to fire
 * it. Counting is a few REST reads and no LLM, so a quiet day costs nothing.
 *
 * "Needs an owner" is DAT-1563's own definition:
 * - an open task (`backlog`, `todo`, `blocked`) with neither an agent nor a
 *   user assigned;
 * - an agent-assigned task parked in `backlog`, where no heartbeat picks it up.
 * A task assigned to a user (Jae) is owned: that is the sweep's "Jae's
 * decision" outcome, not a gap.
 */

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";

export type Issue = {
  id: string;
  identifier: string;
  status: IssueStatus;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

export const OPEN_STATUSES: ReadonlySet<IssueStatus> = new Set(["backlog", "todo", "blocked"]);

/** How many identifiers the webhook payload carries, so the sweep can start somewhere. */
export const SAMPLE_SIZE = 20;

export type GateDecision =
  | { fire: false; unowned: 0; parked: 0 }
  | { fire: true; unowned: number; parked: number; sample: string[] };

export type PaperclipGateApi = {
  /** Every open issue in the company, all pages. */
  listOpenIssues(): Promise<Issue[]>;
  /** Fire the routine's webhook trigger with this payload. */
  fireRoutine(payload: Record<string, unknown>): Promise<void>;
};

export function isUnowned(issue: Issue): boolean {
  return OPEN_STATUSES.has(issue.status) && !issue.assigneeAgentId && !issue.assigneeUserId;
}

export function isParked(issue: Issue): boolean {
  return issue.status === "backlog" && Boolean(issue.assigneeAgentId);
}

export function decide(issues: Issue[]): GateDecision {
  const unowned = issues.filter(isUnowned);
  const parked = issues.filter(isParked);
  if (unowned.length === 0 && parked.length === 0) {
    return { fire: false, unowned: 0, parked: 0 };
  }
  const sample = [...unowned, ...parked].slice(0, SAMPLE_SIZE).map((issue) => issue.identifier);
  return { fire: true, unowned: unowned.length, parked: parked.length, sample };
}

/** One gate tick. Returns what it decided; fires the routine only when there is work. */
export async function runGate(api: PaperclipGateApi, now: Date): Promise<GateDecision & { checkedAt: string }> {
  const decision = decide(await api.listOpenIssues());
  const checkedAt = now.toISOString();
  if (decision.fire) {
    await api.fireRoutine({
      source: "trigger.dev paperclip-backlog-zero-gate",
      checkedAt,
      unowned: decision.unowned,
      parked: decision.parked,
      sample: decision.sample,
    });
  }
  return { ...decision, checkedAt };
}
