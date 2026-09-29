/**
 * Synthetic check for datacrew.space — jaewilson07/datacrew-site#241.
 *
 * On 2026-09-29 the Workers free quota (100k invocations/day) ran out and, with
 * `fail_open`, Cloudflare served a static Next.js 404 for the whole site. A
 * plain status check cannot tell that page from the app's own 404, so every
 * assertion here is on an APP-ONLY signal: the `Strict-Transport-Security`
 * header that the Next.js app adds in `next.config.ts` and a static fallback
 * lacks, and the package index body.
 *
 * Pure: the network probe, the previous-run lookup and the notifier are all
 * injected, so the decision logic is unit-tested without a network.
 */

export const SITE_ORIGIN = "https://datacrew.space";
export const ALERT_AFTER_CONSECUTIVE_FAILURES = 2;
/** Re-alert while an outage persists: every 12th consecutive failure (~1h at 5 min). */
export const REALERT_EVERY = 12;
/** The index renders the wheel filename (underscore), not the dist name: see test-fixtures/dc-auth-prod-index.html. */
export const PACKAGE_MARKER = "dc_auth-0.1.0";

export type ProbeResult = {
  url: string;
  finalUrl: string;
  status: number;
  hsts: string | null;
  body: string | null;
  error?: string;
};

export type Probe = (url: string, opts: { readBody: boolean }) => Promise<ProbeResult>;

export type CheckSpec = {
  name: string;
  url: string;
  readBody: boolean;
  evaluate: (r: ProbeResult) => string | null; // null = pass, string = failure reason
};

export type CheckOutcome = { name: string; url: string; ok: boolean; reason: string | null };

export const SITE_CHECKS: CheckSpec[] = [
  {
    name: "home",
    url: `${SITE_ORIGIN}/`,
    readBody: false,
    evaluate: (r) => {
      if (r.status !== 200) return `expected 200, got ${r.status}`;
      if (!r.hsts) return "200 but no Strict-Transport-Security header (static fallback, not the app)";
      return null;
    },
  },
  {
    name: "app-404",
    url: `${SITE_ORIGIN}/api/sso/nope`,
    readBody: false,
    evaluate: (r) => {
      if (r.status !== 404) return `expected 404, got ${r.status}`;
      if (!r.hsts) return "404 without Strict-Transport-Security header (static Next.js 404, not the app)";
      return null;
    },
  },
  {
    name: "package-index",
    // Explicit index.html skips the 308 from the directory form, which would cost an extra Function invocation.
    url: `${SITE_ORIGIN}/packages/dc-auth/index.html`,
    readBody: true,
    evaluate: (r) => {
      if (r.status !== 200) return `expected 200 after redirects (final ${r.finalUrl}), got ${r.status}`;
      if (!(r.body ?? "").includes(PACKAGE_MARKER)) return `index at ${r.finalUrl} does not list ${PACKAGE_MARKER}`;
      return null;
    },
  },
];

export async function runChecks(probe: Probe, checks: CheckSpec[] = SITE_CHECKS): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    const result = await probe(check.url, { readBody: check.readBody });
    const reason = result.error ? `request failed: ${result.error}` : check.evaluate(result);
    outcomes.push({ name: check.name, url: check.url, ok: reason === null, reason });
  }
  return outcomes;
}

/** The real probe: follows redirects, never throws (an unreachable site is a failed check). */
export const fetchProbe: Probe = async (url, { readBody }) => {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "datacrew-watchdog-site-monitor/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = readBody ? await res.text() : null;
    if (!readBody) await res.body?.cancel();
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      hsts: res.headers.get("strict-transport-security"),
      body,
    };
  } catch (error) {
    return {
      url,
      finalUrl: url,
      status: 0,
      hsts: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export type SiteCheckState = { consecutiveFailures: number };

export type SiteCheckDecision =
  | { action: "none" }
  | { action: "alert"; text: string }
  | { action: "recovered"; text: string };

/** Debounce: alert on the 2nd consecutive failing run, again every REALERT_EVERY, and once on recovery. */
export function decide(previous: SiteCheckState, outcomes: CheckOutcome[]): { state: SiteCheckState; decision: SiteCheckDecision } {
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) {
    const state = { consecutiveFailures: 0 };
    if (previous.consecutiveFailures >= ALERT_AFTER_CONSECUTIVE_FAILURES) {
      return {
        state,
        decision: { action: "recovered", text: ":white_check_mark: datacrew.space app checks are passing again." },
      };
    }
    return { state, decision: { action: "none" } };
  }
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const shouldAlert =
    consecutiveFailures === ALERT_AFTER_CONSECUTIVE_FAILURES ||
    (consecutiveFailures > ALERT_AFTER_CONSECUTIVE_FAILURES &&
      (consecutiveFailures - ALERT_AFTER_CONSECUTIVE_FAILURES) % REALERT_EVERY === 0);
  if (!shouldAlert) return { state: { consecutiveFailures }, decision: { action: "none" } };
  const lines = failed.map((o) => `- ${o.name} (${o.url}): ${o.reason}`);
  const text = [
    `:rotating_light: datacrew.space failed app-only checks ${consecutiveFailures} runs in a row.`,
    ...lines,
    "A 404/200 without the HSTS header means the Workers free quota is likely exhausted and `fail_open` is serving a static page (datacrew-site#241).",
  ].join("\n");
  return { state: { consecutiveFailures }, decision: { action: "alert", text } };
}

export type SiteCheckDeps = {
  probe: Probe;
  previous: () => Promise<SiteCheckState>;
  notify: (text: string) => Promise<void>;
};

export type SiteCheckResult = { outcomes: CheckOutcome[]; consecutiveFailures: number; action: SiteCheckDecision["action"] };

export async function runSiteCheck(deps: SiteCheckDeps): Promise<SiteCheckResult> {
  const previous = await deps.previous();
  const outcomes = await runChecks(deps.probe);
  const { state, decision } = decide(previous, outcomes);
  if (decision.action !== "none") await deps.notify(decision.text);
  return { outcomes, consecutiveFailures: state.consecutiveFailures, action: decision.action };
}
