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

/**
 * `ok` the endpoint answered and met its contract, `degraded` it answered and
 * did NOT, `unknown` it could not be reached at all.
 *
 * The three are deliberately different things. A container that is missing and
 * an endpoint that cannot be dialled are both "we could not tell"; an endpoint
 * that answers `status: "unhealthy"` is a positive statement that something is
 * broken, and only that one should turn the whole report red.
 */
export type EndpointStatus = "ok" | "degraded" | "unknown";

export type EndpointResult = {
  name: string;
  url: string;
  status: EndpointStatus;
  /** null when the request never got a response at all. */
  httpStatus: number | null;
  note: string;
  /**
   * Non-fatal observations. These NEVER change `status` — they are things
   * worth reading in the report ("diarization is on CPU") that are not, on
   * their own, an outage. Kept separate from `note` so a renderer can show
   * them without implying the check failed, and separate from the report's
   * `warnings` (which mean "could not determine") so they are not filed under
   * a heading that misdescribes them.
   */
  advisories: string[];
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
   * Deep readiness probes — does the endpoint actually answer, and does it say
   * it is serving? Added 2026-08-19; reports gathered before then do not carry
   * it, which is why every renderer defaults it to `[]` rather than indexing
   * it blind. A previously-gathered report can legitimately be re-delivered.
   */
  endpointResults: EndpointResult[];
  /**
   * `degraded` if any container is missing or any endpoint answered
   * not-ready, `drifting` if only versions are behind, `unknown` if nothing
   * could be determined, else `healthy`.
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
    // `cosyvoice` (TTS) and `faster-whisper` (STT) are the containers that
    // actually synthesize and transcribe; `voice-gateway` only fronts them.
    // Until 2026-08-19 they were absent from this list, so all three of that
    // day's voice outages left `overallStatus` at `healthy` and were found by
    // a human noticing something felt off. A name check is still only a name
    // check — see ENDPOINT_TARGETS below for the assertion that the stack is
    // actually serving.
    name: "cubby",
    expected: [
      "gateway",
      "llama-swap",
      "letta-local",
      "voice-gateway",
      "cosyvoice",
      "faster-whisper",
      "comfyui-server",
    ],
  },
  {
    name: "bonker",
    expected: ["caddy", "cloudflared", "docker-socket-proxy", "autoheal"],
  },
];

// ---------------------------------------------------------------------------
// Endpoint readiness — the assertion a name check cannot make
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS ALONGSIDE `SERVICE_GROUPS`.
 *
 * `check-service-groups` asks `docker ps` whether a container named
 * `voice-gateway` exists. That is a real check and it catches a stopped or
 * crash-looping container, but it is satisfied by a container that is up and
 * serving 503 to every request. On 2026-08-19 three voice outages happened in
 * one day — a wrong URL plus a retired model (infra-bonker#494), diarization
 * silently falling back to CPU at ~23x slower than GPU (infra-cubby#176), and
 * streaming STT never emitting a final transcript (infra-cubby#175) — and all
 * three would have reported `healthy` here, because every container was
 * running the whole time. All three were found by a human noticing something
 * felt off.
 *
 * So this list holds endpoints that are ASKED, not counted.
 */
export type EndpointTarget = {
  name: string;
  /** Env var that overrides the base URL, so the host is config, not code. */
  envVar: string;
  defaultBaseUrl: string;
  path: string;
};

/**
 * `cubby.lan` IS THE LIVE PATH FROM BONKER, and the Twingate alias is not.
 *
 * `voice-gateway.jaewilson07.twingate.com` does not route from bonker —
 * measured `000` (no response at all) on 2026-08-19, and pointing a caller at
 * it is precisely what broke Open WebUI's voice in both directions
 * (infra-bonker#494). `http://cubby.lan:8885` was verified the same day from
 * inside a default-bridge container on bonker — the network the Trigger.dev
 * worker runs in — returning HTTP 200 and `status: "ok"`. Override with
 * `VOICE_GATEWAY_URL` if that ever stops being true; do not swap in the
 * Twingate alias.
 */
export const VOICE_GATEWAY_DEFAULT_BASE_URL = "http://cubby.lan:8885";

export const ENDPOINT_TARGETS: EndpointTarget[] = [
  {
    name: "voice-gateway /ready",
    envVar: "VOICE_GATEWAY_URL",
    defaultBaseUrl: VOICE_GATEWAY_DEFAULT_BASE_URL,
    // `/ready` and NOT `/health`. `/health` is deliberately shallow — it
    // proves the process is up and that WAV voice profiles loaded from disk,
    // and explicitly does not touch a backend. It returns `ok` with both the
    // TTS and STT backends face down. `/ready` is the deep probe.
    path: "/ready",
  },
];

export function endpointUrl(target: EndpointTarget, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env[target.envVar] || target.defaultBaseUrl).replace(/\/+$/, "");
  return `${base}${target.path}`;
}

/**
 * What one HTTP probe observed, with no judgement applied yet.
 *
 * Split from `evaluateReadiness` so the CONTRACT is a pure function over a
 * plain value and can be unit-tested against every shape a readiness endpoint
 * can return — including the ones nobody has shipped yet — without a network,
 * a fetch mock, or a running gateway.
 */
export type ReadyProbe =
  | { outcome: "unreachable"; error: string }
  | {
      outcome: "responded";
      httpStatus: number;
      /** Parsed body; meaningful only when `jsonParsed` is true. */
      json: unknown;
      jsonParsed: boolean;
      /** First few hundred chars of the raw body, for the failure note. */
      snippet: string;
    };

/**
 * Unwraps `fetch`'s useless top-level message into the actual reason.
 *
 * Undici reports every transport failure as the bare string `"fetch failed"`
 * and hides the part a human needs — `ENOTFOUND`, `ECONNREFUSED`,
 * `ETIMEDOUT`, a TLS error — one level down in `cause`. A `unknown` row whose
 * stated reason is "fetch failed" is the swallowed-error posture this project
 * exists to avoid: it says something went wrong without saying what, so
 * "the host is gone" and "the port moved" look identical in the report.
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return error.message;

  // Undici raises an AggregateError for connect failures whose own `message`
  // is empty and whose `code` carries everything (`ECONNREFUSED`), and a plain
  // Error for DNS failures whose `message` already repeats the code
  // (`getaddrinfo ENOTFOUND host`). Emitting both unconditionally gives you
  // either a trailing space or a stutter, so each part is added only when it
  // says something the other did not.
  const code = (cause as NodeJS.ErrnoException).code;
  const parts = [error.message];
  if (code && !cause.message.includes(code)) parts.push(code);
  if (cause.message.trim()) parts.push(cause.message.trim());
  return parts.join(": ");
}

/** NEVER THROWS — the same contract `runCommand` keeps. */
export async function probeEndpoint(url: string, timeoutMs = 10_000): Promise<ReadyProbe> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        // A bot-shaped User-Agent gets a 403 from the WAF in front of some of
        // these hosts, which reads as an outage and is not one. See AGENTS.md.
        "User-Agent": "datacrew-trigger-infra-health/2.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { outcome: "unreachable", error: describeFetchError(error) };
  }

  const text = await res.text().catch(() => "");
  let json: unknown;
  let jsonParsed = false;
  try {
    json = JSON.parse(text);
    jsonParsed = true;
  } catch {
    jsonParsed = false;
  }
  return { outcome: "responded", httpStatus: res.status, json, jsonParsed, snippet: text.slice(0, 300) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Names of backends the payload itself says are not serving.
 *
 * FORWARD-COMPATIBLE BY CONSTRUCTION. The gateway's per-backend record is
 * `{name, role, url, reachable, status_code?, latency_ms, error?}` today and is
 * actively being changed (a 503 backend is about to stop counting as
 * `reachable`). Everything here is read defensively and anything unrecognised
 * is ignored rather than treated as a failure, so a field being added, renamed
 * or removed downgrades this to "says nothing" — never to a false alarm.
 */
function unhealthyBackends(body: Record<string, unknown>): string[] {
  const backends = Array.isArray(body.backends) ? body.backends : [];
  const names: string[] = [];
  for (const entry of backends) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = typeof record.name === "string" ? record.name : "unnamed backend";
    const code = typeof record.status_code === "number" ? record.status_code : null;
    // `reachable === false` is the explicit signal. A 5xx is included because
    // it is a backend saying it is broken; a 404/405 on a base-URL GET is NOT
    // — that is just a server with no route at `/`, which is how these
    // backends are legitimately probed.
    if (record.reachable === false || (code !== null && code >= 500)) {
      names.push(name);
    }
  }
  return names;
}

function describeBackends(body: Record<string, unknown>): string {
  const unhealthy = unhealthyBackends(body);
  if (unhealthy.length > 0) return ` — backends not serving: ${unhealthy.join(", ")}`;
  const count = Array.isArray(body.backends) ? body.backends.length : 0;
  return count > 0 ? ` — ${count} backend(s) answering` : "";
}

/**
 * Things worth reading that are NOT, by themselves, an outage.
 *
 * `diarization` does not exist in the payload today — it is being added
 * concurrently — so every field is optional-chained and a payload without it
 * simply produces no advisory. That is the point: this reads the CONTRACT
 * (`status === "ok"` decides the verdict), and treats everything else as extra
 * detail it will use if offered.
 */
export function readinessAdvisories(body: Record<string, unknown>): string[] {
  const advisories: string[] = [];

  const diarization = asRecord(body.diarization);
  if (diarization) {
    if (diarization.loaded === false) {
      advisories.push("diarization is not loaded — speaker labels will be missing");
    }
    const loadError = diarization.load_error;
    if (typeof loadError === "string" && loadError.trim().length > 0) {
      advisories.push(`diarization failed to load: ${loadError}`);
    }
    const device = typeof diarization.device === "string" ? diarization.device.toLowerCase() : null;
    if (device === "cpu") {
      // A warning and NOT a failure, deliberately. CPU diarization still
      // produces correct output — it is ~23x slower (infra-cubby#176), which
      // is a real regression and a real thing to notice, but a report that
      // goes red for it would go red on any host without a GPU.
      advisories.push("diarization is running on CPU, not GPU (~23x slower — see infra-cubby#176)");
    }
  }

  // Only when the endpoint claims to be fine: if it says `ok` while naming a
  // backend that is not serving, the disagreement is the interesting part, and
  // nothing else in the report would show it.
  if (body.status === "ok") {
    const unhealthy = unhealthyBackends(body);
    if (unhealthy.length > 0) {
      advisories.push(`reports \`ok\` while these backends are not serving: ${unhealthy.join(", ")}`);
    }
  }

  return advisories;
}

/**
 * The contract, applied. Pure — no network, no clock, no env.
 *
 * The assertion is `HTTP success AND status === "ok"`, and nothing narrower.
 * Anything else the payload carries is read as advisory detail, so a gateway
 * that grows fields does not break this check and a gateway that loses them
 * does not silently pass.
 */
export function evaluateReadiness(name: string, url: string, probe: ReadyProbe): EndpointResult {
  if (probe.outcome === "unreachable") {
    // ONE `unknown` ROW WITH A REASON, never a thrown run. An unreachable
    // dependency is a normal outcome for a check that dials across hosts, and
    // a watchdog that dies when the thing it watches is unreachable is the one
    // failure mode this whole workflow exists to avoid.
    return {
      name,
      url,
      status: "unknown",
      httpStatus: null,
      note: `could not reach ${url}: ${probe.error}`,
      advisories: [],
    };
  }

  const { httpStatus } = probe;
  const httpOk = httpStatus >= 200 && httpStatus < 300;
  const body = probe.jsonParsed ? asRecord(probe.json) : null;

  if (!body) {
    // Something answered, and it was not a readiness endpoint. This is what a
    // wrong URL looks like when a proxy or a login page answers with a
    // cheerful 200 — the exact shape of infra-bonker#494.
    const snippet = probe.snippet.replace(/\s+/g, " ").trim().slice(0, 120);
    return {
      name,
      url,
      status: "degraded",
      httpStatus,
      note: `HTTP ${httpStatus} but the body was not a JSON object — wrong URL, or something else is answering: ${snippet || "(empty body)"}`,
      advisories: [],
    };
  }

  const reported = typeof body.status === "string" ? body.status : null;
  const advisories = readinessAdvisories(body);

  if (!httpOk) {
    return {
      name,
      url,
      status: "degraded",
      httpStatus,
      note: `HTTP ${httpStatus}${reported ? ` (status="${reported}")` : ""}${describeBackends(body)}`,
      advisories,
    };
  }
  if (reported === null) {
    return {
      name,
      url,
      status: "degraded",
      httpStatus,
      note: 'HTTP ' + httpStatus + ' but the payload carried no `status` field — cannot confirm readiness',
      advisories,
    };
  }
  if (reported !== "ok") {
    return {
      name,
      url,
      status: "degraded",
      httpStatus,
      note: `status="${reported}"${describeBackends(body)}`,
      advisories,
    };
  }

  return {
    name,
    url,
    status: "ok",
    httpStatus,
    note: `status="ok"${describeBackends(body)}`,
    advisories,
  };
}

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
  repoResults: CheckResult[],
  // Defaulted rather than required so a caller (or a stored report) from
  // before endpoint checks existed still rolls up correctly instead of
  // crashing on an undefined array.
  endpointResults: EndpointResult[] = []
): { overallStatus: InfraHealthReport["overallStatus"]; warnings: string[] } {
  const warnings: string[] = [];
  for (const r of [...cliResults, ...repoResults]) {
    if (r.status === "unknown") warnings.push(`${r.name}: ${r.note}`);
  }
  for (const s of serviceResults) {
    if (s.status === "unknown") warnings.push(`${s.name}: ${s.note}`);
  }
  for (const e of endpointResults) {
    if (e.status === "unknown") warnings.push(`${e.name}: ${e.note}`);
  }

  // An endpoint that ANSWERED and said it is not serving ranks with a missing
  // container, not below it: it is the same claim ("this is down") made by a
  // more reliable witness. Advisories deliberately do not appear here — a
  // slower-than-it-should-be diarizer is worth reading and is not an outage.
  if (
    serviceResults.some((s) => s.status === "degraded") ||
    endpointResults.some((e) => e.status === "degraded")
  ) {
    return { overallStatus: "degraded", warnings };
  }
  if ([...cliResults, ...repoResults].some((r) => r.status === "out-of-date")) {
    return { overallStatus: "drifting", warnings };
  }
  const anythingKnown =
    cliResults.some((r) => r.status !== "unknown") ||
    serviceResults.some((s) => s.status !== "unknown") ||
    repoResults.some((r) => r.status !== "unknown") ||
    endpointResults.some((e) => e.status !== "unknown");
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
  ok: "✅",
};

/**
 * Endpoint rows carry their icon INLINE, unlike the CLI and service rows.
 *
 * A voice outage that only exists as a word in the middle of a line is a
 * voice outage nobody reads. The status word alone was enough when every row
 * was a version number; a row that means "TTS is down right now" earns the
 * marker at the front of the line.
 */
export function formatEndpointResult(result: EndpointResult): string {
  const head = `• ${STATUS_ICON[result.status] ?? "•"} ${result.name}: ${result.status} (${result.note})`;
  const advisories = result.advisories.map((a) => `    ⚠️ ${a}`);
  return [head, ...advisories].join("\n");
}

export function formatEndpointResults(results: EndpointResult[]): string {
  return results.map(formatEndpointResult).join("\n");
}

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

/**
 * `?? []` is not paranoia: `endpointResults` was added on 2026-08-19 and
 * `infra-health-deliver` is explicitly re-runnable against a report gathered
 * earlier, which will not have the field. Every renderer defaults it.
 */
function endpointsOf(report: InfraHealthReport): EndpointResult[] {
  return report.endpointResults ?? [];
}

export function buildSlackText(report: InfraHealthReport): string {
  return [
    `Infra health report — ${report.overallStatus}`,
    "",
    // Readiness first: it is the section that can say "voice is down right
    // now", and it should not sit below three tables of version numbers.
    "Endpoint readiness",
    formatEndpointResults(endpointsOf(report)) || "(no endpoint results)",
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
  const endpointText = formatEndpointResults(endpointsOf(report));

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
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // Slack hard-fails a section over 3000 chars with `invalid_blocks`,
        // which would drop the whole message — the watchdog going quiet
        // exactly when it has the most to say.
        text: `*Endpoint readiness*\n${(endpointText || "(no endpoint results)").slice(0, 2900)}`,
      },
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

  const endpointResults = endpointsOf(report);
  const endpoints =
    endpointResults.length === 0
      ? "_(no results)_"
      : [
          "| Endpoint | Status | HTTP | Note |",
          "| --- | --- | --- | --- |",
          ...endpointResults.map((e) => {
            // Advisories share the note cell rather than getting a column of
            // their own: a Markdown table cell cannot hold a list, and a
            // mostly-empty fifth column reads as "nothing to see here".
            const advisories = e.advisories.map((a) => ` ⚠️ ${a}`).join("");
            return `| ${e.name} | ${STATUS_ICON[e.status] ?? ""} ${e.status} | ${e.httpStatus ?? "—"} | ${e.note}${advisories} |`;
          }),
        ].join("\n");

  return [
    `# Infra health report — ${report.date}`,
    "",
    `**Overall:** ${STATUS_ICON[report.overallStatus] ?? ""} ${report.overallStatus}  `,
    `**Generated:** ${report.generated_at}  `,
    `**Repo root:** ${report.repoRoot ?? "_not resolved_"}`,
    "",
    "## Endpoint readiness",
    "",
    endpoints,
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
