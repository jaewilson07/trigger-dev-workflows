import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const DEFAULT_CHANNEL_ID = "C0BBWUSTMDZ";

type CliCheck = {
  name: string;
  command: string;
  args: string[];
  parseCurrent: (output: string) => string | null;
  latest: () => Promise<string | null>;
};

type CheckResult = {
  name: string;
  status: "up-to-date" | "out-of-date" | "unknown";
  current: string | null;
  latest: string | null;
  note: string;
};

type ServiceGroupResult = {
  name: string;
  status: "healthy" | "degraded" | "unknown";
  expected: string[];
  running: string[];
  missing: string[];
  note: string;
};

type SchedulePayload = {
  timestamp: Date;
  timezone: string;
};

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    console.warn(
      "Skipping Trigger.dev tags outside managed runtime:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRepoRoot(): Promise<string | null> {
  const configured = process.env.INFRA_MONOREPO_ROOT;
  const candidates = [
    configured,
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    "/home/jaewilson07/GitHub/simpleDiscordBot",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "infrastructure/bonker/infrastructure/docker-compose.yml"))) {
      return candidate;
    }
  }

  return null;
}

async function runCommand(command: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout?.trim() ?? "",
      stderr: err.stderr?.trim() ?? err.message,
    };
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "simpleDiscordBot-trigger-infra-health/1.0",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed for ${url}: ${res.status}`);
  }
  return res.json();
}

function stripVersionPrefix(value: string): string {
  return value.toLowerCase().startsWith("v") ? value.slice(1) : value;
}

function normalizeVersion(value: string): Array<number | string> {
  return stripVersionPrefix(value)
    .split(/[.+_-]/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

function compareVersions(a: string, b: string): number {
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

async function latestGithubRelease(repo: string): Promise<string | null> {
  const payload = (await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`)) as {
    tag_name?: string;
  };
  return payload.tag_name ?? null;
}

async function latestNpmVersion(pkg: string): Promise<string | null> {
  const encoded = pkg.replace("/", "%2F");
  const payload = (await fetchJson(`https://registry.npmjs.org/${encoded}`)) as {
    "dist-tags"?: { latest?: string };
  };
  return payload["dist-tags"]?.latest ?? null;
}

const CLI_CHECKS: CliCheck[] = [
  {
    name: "Infisical CLI",
    command: "infisical",
    args: ["--version"],
    parseCurrent: (output) => output.match(/infisical version ([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null,
    latest: () => latestGithubRelease("Infisical/infisical"),
  },
  {
    name: "Letta CLI",
    command: "letta",
    args: ["--version"],
    parseCurrent: (output) => output.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null,
    latest: () => latestNpmVersion("@letta-ai/letta-code"),
  },
  {
    name: "Claude CLI",
    command: "claude",
    args: ["--version"],
    parseCurrent: (output) => output.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null,
    latest: () => latestNpmVersion("@anthropic-ai/claude-code"),
  },
];

const SERVICE_GROUPS: Array<{ name: string; expected: string[] }> = [
  {
    name: "cubby",
    expected: ["gateway", "llama-swap", "letta-local", "voice-gateway", "comfyui-server"],
  },
  {
    name: "bonker",
    expected: ["caddy", "cloudflared", "docker-socket-proxy", "autoheal"],
  },
];

async function evaluateCliChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CLI_CHECKS) {
    const currentRun = await runCommand(check.command, check.args);
    if (!currentRun.ok) {
      results.push({
        name: check.name,
        status: "unknown",
        current: null,
        latest: null,
        note: currentRun.stderr || "command failed",
      });
      continue;
    }

    const current = check.parseCurrent(currentRun.stdout);
    const latest = await check.latest().catch(() => null);
    if (!current || !latest) {
      results.push({
        name: check.name,
        status: "unknown",
        current,
        latest,
        note: "could not resolve current or latest version",
      });
      continue;
    }

    const cmp = compareVersions(current, latest);
    results.push({
      name: check.name,
      status: cmp < 0 ? "out-of-date" : "up-to-date",
      current,
      latest,
      note: cmp < 0 ? "current is older than latest" : "current matches latest",
    });
  }
  return results;
}

async function evaluateServiceGroups(): Promise<ServiceGroupResult[]> {
  const dockerPs = await runCommand("docker", ["ps", "--format", "{{.Names}}"]);
  if (!dockerPs.ok) {
    return SERVICE_GROUPS.map((group) => ({
      name: group.name,
      status: "unknown",
      expected: group.expected,
      running: [],
      missing: group.expected,
      note: dockerPs.stderr || "docker ps failed",
    }));
  }

  const running = dockerPs.stdout.split("\n").map((line) => line.trim()).filter(Boolean);

  return SERVICE_GROUPS.map((group) => {
    const missing = group.expected.filter((service) => !running.includes(service));
    return {
      name: group.name,
      status: missing.length === 0 ? "healthy" : "degraded",
      expected: group.expected,
      running: running.filter((service) => group.expected.includes(service)),
      missing,
      note: missing.length === 0 ? "all critical containers are running" : "one or more critical containers are missing",
    };
  });
}

async function evaluateRepoConfigDrift(repoRoot: string | null): Promise<CheckResult[]> {
  if (!repoRoot) {
    return [
      {
        name: "Repo-backed config drift",
        status: "unknown",
        current: null,
        latest: null,
        note: "INFRA_MONOREPO_ROOT not available in task runtime",
      },
    ];
  }

  const specs = [
    {
      name: "caddy release",
      file: "infrastructure/bonker/infrastructure/docker-compose.yml",
      regex: /caddy:([A-Za-z0-9._-]+)/,
      latest: () => latestGithubRelease("caddyserver/caddy"),
    },
    {
      name: "cloudflared release",
      file: "infrastructure/bonker/infrastructure/docker-compose.yml",
      regex: /cloudflared:([A-Za-z0-9._-]+)/,
      latest: () => latestGithubRelease("cloudflare/cloudflared"),
    },
    {
      name: "vllm (llama-swap engines)",
      file: "infrastructure/cubby/apps/llama-swap/config.yaml",
      regex: /vllm\/vllm-openai:v([0-9]+\.[0-9]+\.[0-9]+)/,
      latest: async () => {
        const payload = (await fetchJson("https://pypi.org/pypi/vllm/json")) as { info?: { version?: string } };
        return payload.info?.version ?? null;
      },
    },
  ];

  const results: CheckResult[] = [];
  for (const spec of specs) {
    const fullPath = path.join(repoRoot, spec.file);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      const current = content.match(spec.regex)?.[1] ?? null;
      const latest = await spec.latest().catch(() => null);
      if (!current || !latest) {
        results.push({
          name: spec.name,
          status: "unknown",
          current,
          latest,
          note: "could not resolve current or latest version",
        });
        continue;
      }

      const cmp = compareVersions(current, latest);
      results.push({
        name: spec.name,
        status: cmp < 0 ? "out-of-date" : "up-to-date",
        current,
        latest,
        note: cmp < 0 ? "current is older than latest" : "current matches latest",
      });
    } catch (error) {
      results.push({
        name: spec.name,
        status: "unknown",
        current: null,
        latest: null,
        note: error instanceof Error ? error.message : "failed reading config file",
      });
    }
  }

  return results;
}

function formatCliChecks(results: CheckResult[]): string {
  return results
    .map((result) => `• ${result.name}: ${result.current ?? "?"} -> ${result.latest ?? "?"} (${result.status})`)
    .join("\n");
}

function formatServiceGroup(result: ServiceGroupResult): string {
  const detail = result.missing.length > 0 ? `missing ${result.missing.join(", ")}` : result.note;
  return `• ${result.name}: ${result.status} (${detail})`;
}

function buildSlackText(cliChecks: string, serviceChecks: string, repoChecks: string): string {
  return [
    "Infra health report",
    "",
    "CLI drift",
    cliChecks || "(no CLI results)",
    "",
    "Critical services",
    serviceChecks || "(no service results)",
    "",
    "Repo-config drift",
    repoChecks || "(no repo-config results)",
  ].join("\n");
}

async function postToSlack(text: string, blocks: unknown[]): Promise<void> {
  const token = await getSecret("DATACREW_SLACK_BOT_TOKEN");
  const channel = process.env.DATACREW_INFRA_SLACK_CHANNEL_ID || DEFAULT_CHANNEL_ID;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, blocks }),
  });

  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Slack post failed: ${res.status} ${data.error ?? "unknown_error"}`);
  }
}

export async function runInfrastructureHealthReport(payload: SchedulePayload): Promise<{
  status: "ok";
  repoRoot: string | null;
  cliResults: CheckResult[];
  serviceResults: ServiceGroupResult[];
  repoResults: CheckResult[];
}> {
  await safeAddTags(["infra", "health", "bonker", "cubby"]);
  logger.info("Starting infrastructure health workflow", {
    timestamp: payload.timestamp.toISOString(),
    timezone: payload.timezone,
  });

  const repoRoot = await resolveRepoRoot();

  logger.info("Resolved monorepo root", { repoRoot: repoRoot ?? "not-found" });

  const cliResults = await evaluateCliChecks();
  const serviceResults = await evaluateServiceGroups();
  const repoResults = await evaluateRepoConfigDrift(repoRoot);

  const cliText = formatCliChecks(cliResults);
  const serviceText = serviceResults.map(formatServiceGroup).join("\n");
  const repoText = formatCliChecks(repoResults);

  const text = buildSlackText(cliText, serviceText, repoText);
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "Infra health report" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*CLI drift*\n${cliText || "(no CLI results)"}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Critical services*\n${serviceText || "(no service results)"}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Repo-config drift*\n${repoText || "(unavailable)"}` },
    },
  ];

  await postToSlack(text, blocks);

  return {
    status: "ok" as const,
    repoRoot,
    cliResults,
    serviceResults,
    repoResults,
  };
}

export const infrastructureHealthReport = schedules.task({
  id: "infrastructure-health-report",
  cron: {
    pattern: "0 14 * * *",
    environments: ["PRODUCTION"],
  },
  run: async (payload: SchedulePayload) => runInfrastructureHealthReport(payload),
});