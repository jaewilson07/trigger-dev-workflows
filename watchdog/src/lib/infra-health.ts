/**
 * Shared types and pure helpers for the infrastructure health workflow.
 *
 * Everything here is side-effect-free or a thin wrapper over one I/O call, and
 * — critically — none of it knows about Slack, Drive, or any other
 * destination. That separation is the point of the decomposition: the three
 * checks became three tasks, the rendering became a function the delivery half
 * calls, and `postToSlack` stopped being something the gather step could reach.
 *
 * See `docs/watchdog-rework.md`.
 */

/**
 * The three check tasks take no input — they inspect the host they run on.
 *
 * They still declare a payload type rather than `run: async ()`, because a task
 * with no payload parameter is typed `void`, and `batch.triggerByTaskAndWait`
 * cannot then be handed a `{ payload: {} }` entry for it. An explicit empty
 * object is what makes them composable into the fan-out.
 */
export type InfraCheckPayload = Record<string, never>;

export type CheckStatus = "up-to-date" | "out-of-date" | "unknown";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  current: string | null;
  latest: string | null;
  note: string;
};

export type ServiceGroupResult = {
  name: string;
  status: "healthy" | "degraded" | "unknown";
  expected: string[];
  running: string[];
  missing: string[];
  note: string;
};

/**
 * The seam between `infra-health-research` and `infra-health-deliver`.
 *
 * Structured, not rendered — the same call `executive-assistant`'s
 * `BriefResearch` makes, and for the same reason: Slack wants Block Kit, Drive
 * wants markdown, and a future destination (a Domo dataset, a status page) will
 * want rows. A destination handed only a pre-rendered string could serve one of
 * those.
 *
 * `overallStatus` is computed once, HERE, rather than by each destination, so
 * Slack and Drive can never disagree about whether the estate is healthy.
 */
export type InfraHealthReport = {
  /** `YYYY-MM-DD` the report is about, stamped once by the research half. */
  date: string;
  generated_at: string;
  /** Where the repo-config check read from, or null when it could not resolve one. */
  repoRoot: string | null;
  cliResults: CheckResult[];
  serviceResults: ServiceGroupResult[];
  repoResults: CheckResult[];
  /**
   * `degraded` if any container is missing, `drifting` if only versions are
   * behind, `unknown` if nothing could be determined, else `healthy`.
   */
  overallStatus: "healthy" | "drifting" | "degraded" | "unknown";
  /** One line per check that failed to resolve — visible, not swallowed. */
  warnings: string[];
};

export const CLI_TARGETS = [
  { name: "Infisical CLI", command: "infisical", args: ["--version"], source: "github:Infisical/infisical" },
  { name: "Letta CLI", command: "letta", args: ["--version"], source: "npm:@letta-ai/letta-code" },
  { name: "Claude CLI", command: "claude", args: ["--version"], source: "npm:@anthropic-ai/claude-code" },
] as const;

export const SERVICE_GROUPS: Array<{ name: string; expected: string[] }> = [
  {
    name: "cubby",
    expected: ["gateway", "llama-swap", "letta-local", "voice-gateway", "comfyui-server"],
  },
  {
    name: "bonker",
    expected: ["caddy", "cloudflared", "docker-socket-proxy", "autoheal"],
  },
];

// ---------------------------------------------------------------------------
// Version comparison — unchanged behaviour, lifted verbatim
// ---------------------------------------------------------------------------

function stripVersionPrefix(value: string): string {
  return value.toLowerCase().startsWith("v") ? value.slice(1) : value;
}

function normalizeVersion(value: string): Array<number | string> {
  return stripVersionPrefix(value)
    .split(/[.+_-]/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const lhs = left[index] ?? 0;
    const rhs = right[index] ?? 0;
    if (lhs === rhs) continue;
    if (typeof lhs === "number" && typeof rhs === "number") {
      return lhs < rhs ? -1 : 1;
    }
    return String(lhs) < String(rhs) ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Registry lookups
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "datacrew-trigger-infra-health/2.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Fetch failed for ${url}: ${res.status}`);
  }
  return res.json();
}

export async function latestGithubRelease(repo: string): Promise<string | null> {
  const payload = (await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`)) as {
    tag_name?: string;
  };
  return payload.tag_name ?? null;
}

export async function latestNpmVersion(pkg: string): Promise<string | null> {
  const encoded = pkg.replace("/", "%2F");
  const payload = (await fetchJson(`https://registry.npmjs.org/${encoded}`)) as {
    "dist-tags"?: { latest?: string };
  };
  return payload["dist-tags"]?.latest ?? null;
}

export async function latestPypiVersion(pkg: string): Promise<string | null> {
  const payload = (await fetchJson(`https://pypi.org/pypi/${pkg}/json`)) as {
    info?: { version?: string };
  };
  return payload.info?.version ?? null;
}

/** `"github:owner/repo"` | `"npm:pkg"` | `"pypi:pkg"` → the latest version. */
export async function latestFromSource(source: string): Promise<string | null> {
  const [kind, ...rest] = source.split(":");
  const name = rest.join(":");
  switch (kind) {
    case "github":
      return latestGithubRelease(name);
    case "npm":
      return latestNpmVersion(name);
    case "pypi":
      return latestPypiVersion(name);
    default:
      throw new Error(`unknown version source: ${source}`);
  }
}

/** The one place a version string is turned into a `CheckResult`. */
export function compareToCheckResult(
  name: string,
  current: string | null,
  latest: string | null
): CheckResult {
  if (!current || !latest) {
    return { name, status: "unknown", current, latest, note: "could not resolve current or latest version" };
  }
  const cmp = compareVersions(current, latest);
  return {
    name,
    status: cmp < 0 ? "out-of-date" : "up-to-date",
    current,
    latest,
    note: cmp < 0 ? "current is older than latest" : "current matches latest",
  };
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

/**
 * A missing CONTAINER is worse than an outdated CLI, and "we could not tell"
 * is worse than "everything is fine" — so the rollup is ordered rather than a
 * count. The old inline version had no rollup at all: it posted three lists and
 * left the reader to decide, which meant a missing `caddy` looked exactly as
 * urgent as a patch-behind CLI.
 */
export function rollUp(
  cliResults: CheckResult[],
  serviceResults: ServiceGroupResult[],
  repoResults: CheckResult[]
): { overallStatus: InfraHealthReport["overallStatus"]; warnings: string[] } {
  const warnings: string[] = [];
  for (const r of [...cliResults, ...repoResults]) {
    if (r.status === "unknown") warnings.push(`${r.name}: ${r.note}`);
  }
  for (const s of serviceResults) {
    if (s.status === "unknown") warnings.push(`${s.name}: ${s.note}`);
  }

  if (serviceResults.some((s) => s.status === "degraded")) {
    return { overallStatus: "degraded", warnings };
  }
  if ([...cliResults, ...repoResults].some((r) => r.status === "out-of-date")) {
    return { overallStatus: "drifting", warnings };
  }
  const anythingKnown =
    cliResults.some((r) => r.status !== "unknown") ||
    serviceResults.some((s) => s.status !== "unknown") ||
    repoResults.some((r) => r.status !== "unknown");
  return { overallStatus: anythingKnown ? "healthy" : "unknown", warnings };
}

// ---------------------------------------------------------------------------
// Rendering — called by the DELIVERY half only
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, string> = {
  "up-to-date": "✅",
  "out-of-date": "⚠️",
  unknown: "❓",
  healthy: "✅",
  degraded: "🔴",
  drifting: "⚠️",
};

export function formatCheckResults(results: CheckResult[]): string {
  return results
    .map(
      (result) =>
        `• ${result.name}: ${result.current ?? "?"} -> ${result.latest ?? "?"} (${result.status})`
    )
    .join("\n");
}

export function formatServiceGroup(result: ServiceGroupResult): string {
  const detail = result.missing.length > 0 ? `missing ${result.missing.join(", ")}` : result.note;
  return `• ${result.name}: ${result.status} (${detail})`;
}

export function buildSlackText(report: InfraHealthReport): string {
  return [
    `Infra health report — ${report.overallStatus}`,
    "",
    "CLI drift",
    formatCheckResults(report.cliResults) || "(no CLI results)",
    "",
    "Critical services",
    report.serviceResults.map(formatServiceGroup).join("\n") || "(no service results)",
    "",
    "Repo-config drift",
    formatCheckResults(report.repoResults) || "(no repo-config results)",
  ].join("\n");
}

export function buildSlackBlocks(report: InfraHealthReport): unknown[] {
  const cliText = formatCheckResults(report.cliResults);
  const serviceText = report.serviceResults.map(formatServiceGroup).join("\n");
  const repoText = formatCheckResults(report.repoResults);

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "Infra health report", emoji: true } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${STATUS_ICON[report.overallStatus] ?? "•"} *${report.overallStatus}* · ${report.date}`,
        },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*CLI drift*\n${cliText || "(no CLI results)"}` } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Critical services*\n${serviceText || "(no service results)"}` },
    },
    { type: "section", text: { type: "mrkdwn", text: `*Repo-config drift*\n${repoText || "(unavailable)"}` } },
  ];

  if (report.warnings.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          // Truncated to Slack's 3000-char context limit; the full list is in
          // the report object and the Google Doc.
          text: `❓ *Could not determine:*\n${report.warnings.join("\n").slice(0, 2900)}`,
        },
      ],
    });
  }

  return blocks;
}

/** Markdown for the Drive destination — the full report, nothing truncated. */
export function buildMarkdown(report: InfraHealthReport): string {
  const table = (rows: CheckResult[]) =>
    rows.length === 0
      ? "_(no results)_"
      : [
          "| Check | Current | Latest | Status | Note |",
          "| --- | --- | --- | --- | --- |",
          ...rows.map(
            (r) =>
              `| ${r.name} | ${r.current ?? "?"} | ${r.latest ?? "?"} | ${STATUS_ICON[r.status] ?? ""} ${r.status} | ${r.note} |`
          ),
        ].join("\n");

  const services =
    report.serviceResults.length === 0
      ? "_(no results)_"
      : [
          "| Group | Status | Running | Missing | Note |",
          "| --- | --- | --- | --- | --- |",
          ...report.serviceResults.map(
            (s) =>
              `| ${s.name} | ${STATUS_ICON[s.status] ?? ""} ${s.status} | ${s.running.join(", ") || "—"} | ${s.missing.join(", ") || "—"} | ${s.note} |`
          ),
        ].join("\n");

  return [
    `# Infra health report — ${report.date}`,
    "",
    `**Overall:** ${STATUS_ICON[report.overallStatus] ?? ""} ${report.overallStatus}  `,
    `**Generated:** ${report.generated_at}  `,
    `**Repo root:** ${report.repoRoot ?? "_not resolved_"}`,
    "",
    "## CLI drift",
    "",
    table(report.cliResults),
    "",
    "## Critical services",
    "",
    services,
    "",
    "## Repo-config drift",
    "",
    table(report.repoResults),
    "",
    ...(report.warnings.length > 0
      ? ["## Could not determine", "", ...report.warnings.map((w) => `- ${w}`), ""]
      : []),
  ].join("\n");
}
