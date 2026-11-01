/**
 * Stall gate: a deterministic status sweep of Paperclip, with no LLM.
 *
 * It lists every open issue with its status, owner, last message and any
 * pending human card, and labels each one with the stall pattern it matches
 * (the same table ProjectManager's instructions use). Two outputs:
 * - a Slack digest for Jae, grouped by project; and
 * - a decision to wake ProjectManager's keep-moving sweep, made only when some
 *   issue matches a pattern that needs an agent's judgement to resume.
 *
 * Detection is a handful of REST reads, so a quiet sweep costs no model tokens.
 * ProjectManager hit the Claude org's monthly spend cap on 2026-10-22, which is
 * why detection moved out of the agent.
 */

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export type GateIssue = {
  id: string;
  identifier: string;
  title: string;
  status: IssueStatus;
  projectId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  lastActivityAt: string | null;
  updatedAt: string;
};

export type GateRun = {
  id: string;
  agentId: string;
  status: string;
  errorCode: string | null;
  error: string | null;
  createdAt: string;
  issueId: string | null;
};

export type LastMessage = { at: string; author: string; excerpt: string };

export type Signal =
  | "orphaned" // run killed mid-flight (usually a paperclip OOM); issue still in_progress, nothing live
  | "stranded_queue" // a run queued > 30 min
  | "out_of_tokens" // last run hit a quota / spend cap
  | "stale_block" // blocked with no activity for > 24h
  | "idle" // in_progress / in_review with no activity for > 24h and nothing live
  | "retries_exhausted" // Paperclip's own "retry budget is spent" note is the last word
  | "needs_jae"; // a pending human card: waiting on Jae, not broken

/** Signals that need an agent to resume the work. `needs_jae` goes to Jae; `out_of_tokens` waits for its reset. */
export const AGENT_SIGNALS: ReadonlySet<Signal> = new Set([
  "orphaned",
  "stranded_queue",
  "stale_block",
  "idle",
  "retries_exhausted",
]);

export const OPEN_STATUSES = "todo,in_progress,in_review,blocked";
const HOUR = 3_600_000;
const STALE_MS = 24 * HOUR;
const QUEUE_MS = 30 * 60_000;
const QUOTA_RE =
  /provider_quota|spend limit|inference|quota|insufficient credits|usage limit/i;
const LIVE = new Set(["queued", "running"]);
const RETRIES_SPENT_RE =
  /retry budget is spent|retried .{0,80}\bonce\b.{0,80}still has no/i;

export type Row = {
  issue: GateIssue;
  project: string;
  owner: string;
  last: LastMessage | null;
  pendingCards: number;
  signals: Signal[];
};

export type Directory = {
  projects: Map<string, string>;
  agents: Map<string, string>;
};

/**
 * Classify one issue. Pure: everything it needs is passed in.
 *
 * A pending card means the issue is waiting on Jae. So `needs_jae` replaces
 * `idle` and `stale_block` rather than adding to them: waking an agent can't
 * answer Jae's question.
 */
export function signalsFor(
  issue: GateIssue,
  runs: GateRun[],
  pendingCards: number,
  now: Date,
  last: LastMessage | null = null,
): Signal[] {
  const out: Signal[] = [];
  const mine = runs
    .filter((r) => r.issueId === issue.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const live = mine.some((r) => LIVE.has(r.status));
  const latest = mine[0];
  const quiet =
    now.getTime() - Date.parse(issue.lastActivityAt ?? issue.updatedAt) >
    STALE_MS;

  if (
    issue.status === "in_progress" &&
    !live &&
    latest?.errorCode === "orphaned_running_run"
  )
    out.push("orphaned");
  if (
    mine.some(
      (r) =>
        r.status === "queued" &&
        now.getTime() - Date.parse(r.createdAt) > QUEUE_MS,
    )
  )
    out.push("stranded_queue");
  if (
    latest &&
    latest.status === "failed" &&
    QUOTA_RE.test(`${latest.errorCode ?? ""} ${latest.error ?? ""}`)
  )
    out.push("out_of_tokens");
  if (pendingCards > 0) {
    out.push("needs_jae");
    return out;
  }
  if (last?.author === "system" && RETRIES_SPENT_RE.test(last.excerpt) && !live)
    out.push("retries_exhausted");
  if (issue.status === "blocked" && quiet && !out.includes("retries_exhausted"))
    out.push("stale_block");
  if (
    (issue.status === "in_progress" || issue.status === "in_review") &&
    quiet &&
    !live &&
    !out.includes("orphaned") &&
    !out.includes("retries_exhausted")
  )
    out.push("idle");
  return out;
}

export function buildRows(
  issues: GateIssue[],
  runs: GateRun[],
  last: Map<string, LastMessage | null>,
  cards: Map<string, number>,
  dir: Directory,
  now: Date,
): Row[] {
  return issues.map((issue) => ({
    issue,
    project:
      (issue.projectId && dir.projects.get(issue.projectId)) || "(no project)",
    owner: issue.assigneeAgentId
      ? (dir.agents.get(issue.assigneeAgentId) ?? "agent?")
      : issue.assigneeUserId
        ? "Jae"
        : "unowned",
    last: last.get(issue.id) ?? null,
    pendingCards: cards.get(issue.id) ?? 0,
    signals: signalsFor(
      issue,
      runs,
      cards.get(issue.id) ?? 0,
      now,
      last.get(issue.id) ?? null,
    ),
  }));
}

/** Resume order: fresh breakage first. A run killed an hour ago matters more than a block from last month. */
const SEVERITY: Signal[] = [
  "orphaned",
  "retries_exhausted",
  "stranded_queue",
  "idle",
  "stale_block",
];

export function needsAgent(rows: Row[]): Row[] {
  const rank = (r: Row) =>
    Math.min(
      ...r.signals.map((s) =>
        SEVERITY.includes(s) ? SEVERITY.indexOf(s) : SEVERITY.length,
      ),
    );
  const when = (r: Row) =>
    Date.parse(r.issue.lastActivityAt ?? r.issue.updatedAt);
  return rows
    .filter((r) => r.signals.some((s) => AGENT_SIGNALS.has(s)))
    .sort((a, b) => rank(a) - rank(b) || when(b) - when(a));
}

function age(iso: string, now: Date): string {
  const h = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / HOUR));
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const ICON: Record<Signal, string> = {
  orphaned: ":skull:",
  stranded_queue: ":hourglass:",
  out_of_tokens: ":battery:",
  stale_block: ":no_entry:",
  idle: ":zzz:",
  retries_exhausted: ":repeat:",
  needs_jae: ":raising_hand:",
};

export function formatRow(r: Row, now: Date): string {
  const flags = r.signals.map((s) => ICON[s]).join("");
  const last = r.last
    ? `${r.last.author} ${age(r.last.at, now)} ago: “${r.last.excerpt}”`
    : "no messages";
  return `${flags ? flags + " " : ""}*${r.issue.identifier}* \`${r.issue.status}\` ${r.issue.title.slice(0, 70)} · ${r.owner} · ${last}`;
}

/** Slack digest: one summary line plus one message per project. Projects with a flagged issue come first. */
export function formatDigest(
  rows: Row[],
  now: Date,
  jaeSlackId: string,
): { summary: string; projects: string[] } {
  const flagged = rows.filter((r) => r.signals.length > 0);
  const jae = rows.filter((r) => r.signals.includes("needs_jae"));
  const agent = needsAgent(rows);
  const summary =
    `${jae.length ? `<@${jaeSlackId}> ` : ""}*Paperclip status* · ${rows.length} open · ` +
    `${agent.length} broken (agent resuming) · ${jae.length} waiting on you · ${rows.length - flagged.length} moving\n` +
    `${ICON.needs_jae} needs you  ${ICON.orphaned} orphaned  ${ICON.stranded_queue} stuck queue  ${ICON.stale_block} stale block  ${ICON.idle} idle >24h  ${ICON.retries_exhausted} retries spent  ${ICON.out_of_tokens} out of tokens`;
  const byProject = new Map<string, Row[]>();
  for (const r of rows)
    byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]);
  const projects = [...byProject.entries()]
    .sort(
      ([, a], [, b]) =>
        b.filter((r) => r.signals.length).length -
        a.filter((r) => r.signals.length).length,
    )
    .map(([name, list]) => {
      const sorted = [...list].sort(
        (a, b) =>
          b.signals.length - a.signals.length ||
          a.issue.identifier.localeCompare(b.issue.identifier),
      );
      const shown = sorted.slice(0, 25).map((r) => formatRow(r, now));
      const more =
        sorted.length > 25 ? `\n…and ${sorted.length - 25} more` : "";
      return `*${name}* (${list.length})\n${shown.join("\n")}${more}`;
    });
  return { summary, projects };
}
