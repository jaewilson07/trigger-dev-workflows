/**
 * Audit: Paperclip agents on the `letta_cloud` adapter with no `conversationId`
 * in `adapterConfig`. Without one, every heartbeat run opens a NEW Letta
 * conversation instead of resuming the agent's own (Rizz ran like this until
 * 2026-10-23). A pinned agent keeps one conversation; an unpinned one loses
 * its thread each run.
 *
 * REPORT-ONLY. Nothing here writes to Paperclip: the only Paperclip call is a
 * GET of the company's agent list. Findings go to Slack as the DataCrew bot
 * (the emmabot identity, same as every other watchdog report).
 *
 * Route (observed live 2026-10-23, read-only): `GET /api/companies/:id/agents`
 * answers a bare JSON array of agents, each with `id`, `name`, `status`,
 * `adapterType` and `adapterConfig`. `GET /api/agents` is a 404. Non-2xx
 * throws, per the repo's "API client layers raise" rule.
 *
 * Idempotent: the task output records which agents were unpinned and when
 * Slack was last told. A re-run alerts again only if the unpinned set changed
 * or `REMIND_AFTER_MS` has passed, so an unfixed agent produces a daily
 * reminder, not an hourly one.
 */

export const LETTA_ADAPTER_TYPE = "letta_cloud";
export const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
/** Agents in these states are retired; an unpinned retired agent is not a finding. */
const IGNORED_STATUSES = new Set(["terminated", "archived"]);

export class PaperclipAgentsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PaperclipAgentsError";
    this.status = status;
  }
}

export class PaperclipAgentsShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperclipAgentsShapeError";
  }
}

export type PaperclipAgent = {
  id: string;
  name: string;
  status?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown> | null;
};

export type Finding = { id: string; name: string; status: string };

export type AuditOutput = {
  /** Sorted ids of the agents found unpinned on this run. */
  unpinnedIds: string[];
  findings: Finding[];
  /** ISO time Slack was last told about the current set; carried over while the set stays unchanged. */
  lastAlertedAt: string | null;
  checked: number;
  alerted: boolean;
};

export type AuditDeps = {
  fetchAgents: () => Promise<PaperclipAgent[]>;
  notify: (text: string) => Promise<void>;
  previous: () => Promise<AuditOutput | null>;
  now: Date;
};

/** A conversationId counts as pinned only if it is a non-blank string. */
export function isPinned(agent: PaperclipAgent): boolean {
  const id = agent.adapterConfig?.conversationId;
  return typeof id === "string" && id.trim() !== "";
}

export function findUnpinned(agents: PaperclipAgent[]): Finding[] {
  return agents
    .filter((a) => a.adapterType === LETTA_ADAPTER_TYPE)
    .filter((a) => !IGNORED_STATUSES.has((a.status ?? "").toLowerCase()))
    .filter((a) => !isPinned(a))
    .map((a) => ({ id: a.id, name: a.name, status: a.status ?? "unknown" }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildMessage(findings: Finding[]): string {
  const lines = findings.map((f) => `- ${f.name} (${f.id}, status: ${f.status})`);
  return [
    `Paperclip audit: ${findings.length} letta_cloud agent(s) have no \`conversationId\` in adapterConfig, so every run opens a new Letta conversation.`,
    ...lines,
    "Pin each one to a conversation (adapterConfig.conversationId). This audit is report-only and changed nothing.",
  ].join("\n");
}

function sameSet(findings: Finding[], previous: AuditOutput | null): boolean {
  return previous !== null && previous.unpinnedIds.join(",") === findings.map((f) => f.id).join(",");
}

export function shouldAlert(findings: Finding[], previous: AuditOutput | null, now: Date): boolean {
  if (findings.length === 0) return false;
  if (previous === null || previous.lastAlertedAt === null || !sameSet(findings, previous)) return true;
  return now.getTime() - Date.parse(previous.lastAlertedAt) >= REMIND_AFTER_MS;
}

export async function runAudit(deps: AuditDeps): Promise<AuditOutput> {
  const agents = await deps.fetchAgents();
  const findings = findUnpinned(agents);
  const previous = await deps.previous();
  const alert = shouldAlert(findings, previous, deps.now);
  if (alert) await deps.notify(buildMessage(findings));
  let lastAlertedAt: string | null = null;
  if (alert) lastAlertedAt = deps.now.toISOString();
  else if (findings.length > 0 && sameSet(findings, previous)) lastAlertedAt = previous?.lastAlertedAt ?? null;
  return {
    unpinnedIds: findings.map((f) => f.id),
    findings,
    lastAlertedAt,
    checked: agents.length,
    alerted: alert,
  };
}

const PAPERCLIP_BASE = "https://paperclip.datacrew.space/api";
export const DATACREW_COMPANY_ID = "9da83648-583b-4f62-9049-888eae6ad8ae";
export const REQUEST_TIMEOUT_MS = 30_000;

/** GET the company's agents. Throws PaperclipAgentsError on non-2xx, PaperclipAgentsShapeError on a non-array body. */
export async function fetchPaperclipAgents(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<PaperclipAgent[]> {
  const res = await fetchImpl(`${PAPERCLIP_BASE}/companies/${DATACREW_COMPANY_ID}/agents`, {
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "datacrew-claude-code/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const status = Number(res.status);
  if (status < 200 || status >= 300) {
    throw new PaperclipAgentsError(`Paperclip GET /companies/:id/agents failed: ${status}`, status);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new PaperclipAgentsShapeError("Paperclip agents response was not a JSON array");
  return body as PaperclipAgent[];
}
