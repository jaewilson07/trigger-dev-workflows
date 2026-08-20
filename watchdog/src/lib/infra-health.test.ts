import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMarkdown,
  buildSlackBlocks,
  buildSlackText,
  endpointUrl,
  evaluateReadiness,
  probeEndpoint,
  rollUp,
  SERVICE_GROUPS,
  VOICE_GATEWAY_DEFAULT_BASE_URL,
  ENDPOINT_TARGETS,
} from "./infra-health.js";
import type { EndpointResult, InfraHealthReport, ReadyProbe } from "./infra-health.js";

const responded = (httpStatus: number, body: unknown): ReadyProbe => ({
  outcome: "responded",
  httpStatus,
  json: body,
  jsonParsed: true,
  snippet: JSON.stringify(body),
});

const raw = (httpStatus: number, snippet: string): ReadyProbe => ({
  outcome: "responded",
  httpStatus,
  json: undefined,
  jsonParsed: false,
  snippet,
});

const evaluate = (probe: ReadyProbe): EndpointResult =>
  evaluateReadiness("voice-gateway /ready", "http://cubby.lan:8885/ready", probe);

/** The live payload shape as measured from bonker on 2026-08-19. */
const liveOkBody = {
  status: "ok",
  backends: [
    { name: "cosyvoice", role: "tts", url: "http://cosyvoice:8887", reachable: true, status_code: 404, latency_ms: 23.5 },
    { name: "faster-whisper", role: "stt", url: "http://faster-whisper:8886", reachable: true, status_code: 404, latency_ms: 13.9 },
  ],
  voices: ["alix", "guest", "host", "tutor"],
};

// ---------------------------------------------------------------------------
// The containers that actually do the work
// ---------------------------------------------------------------------------

test("cubby's critical containers include the ones that synthesize and transcribe", () => {
  // Until 2026-08-19 only `voice-gateway` was listed, so the TTS and STT
  // containers could be stopped, crash-looping or OOM'd with `overallStatus`
  // still reading `healthy`.
  const cubby = SERVICE_GROUPS.find((group) => group.name === "cubby");
  assert.ok(cubby, "cubby group exists");
  assert.ok(cubby.expected.includes("cosyvoice"), "cosyvoice is watched");
  assert.ok(cubby.expected.includes("faster-whisper"), "faster-whisper is watched");
});

test("the voice readiness probe points at cubby.lan and not the Twingate alias", () => {
  // `voice-gateway.jaewilson07.twingate.com` does not route from bonker
  // (measured `000` on 2026-08-19) and is what broke Open WebUI's voice.
  assert.equal(VOICE_GATEWAY_DEFAULT_BASE_URL, "http://cubby.lan:8885");
  const target = ENDPOINT_TARGETS.find((t) => t.name === "voice-gateway /ready");
  assert.ok(target, "the voice gateway is probed");
  assert.equal(endpointUrl(target, {}), "http://cubby.lan:8885/ready");
  assert.equal(
    endpointUrl(target, { VOICE_GATEWAY_URL: "http://localhost:8885/" }),
    "http://localhost:8885/ready",
    "an override wins, and a trailing slash does not produce a double slash"
  );
});

test("the probe asserts /ready, not the deliberately shallow /health", () => {
  // `/health` answers `ok` with both GPU backends face down — it only proves a
  // WAV file loaded off disk. Checking it would reproduce the bug, not catch it.
  const target = ENDPOINT_TARGETS.find((t) => t.name === "voice-gateway /ready");
  assert.equal(target?.path, "/ready");
});

// ---------------------------------------------------------------------------
// The contract: HTTP success AND status === "ok"
// ---------------------------------------------------------------------------

test("a healthy gateway is ok", () => {
  const result = evaluate(responded(200, liveOkBody));
  assert.equal(result.status, "ok");
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.advisories, []);
});

test("HTTP 503 with status degraded is degraded, and names the dead backend", () => {
  const result = evaluate(
    responded(503, {
      status: "degraded",
      backends: [
        { name: "cosyvoice", reachable: true, status_code: 200 },
        { name: "faster-whisper", reachable: false, error: "connection refused" },
      ],
    })
  );
  assert.equal(result.status, "degraded");
  assert.match(result.note, /faster-whisper/, "the report says WHICH backend is down");
});

test("a 200 that does not say ok is still degraded", () => {
  // Belt and braces: the assertion is HTTP success AND status === "ok", so a
  // gateway that stops setting a non-2xx code cannot slip past.
  const result = evaluate(responded(200, { status: "unhealthy", backends: [] }));
  assert.equal(result.status, "degraded");
  assert.match(result.note, /unhealthy/);
});

test("a 200 with no status field cannot be confirmed ready", () => {
  const result = evaluate(responded(200, { backends: [], voices: [] }));
  assert.equal(result.status, "degraded");
  assert.match(result.note, /no `status` field/);
});

test("a cheerful 200 from the wrong URL is degraded, not healthy", () => {
  // This is the shape of infra-bonker#494: a proxy or a login page answering
  // 200 at a URL that is not the gateway.
  const result = evaluate(raw(200, "<!doctype html><html><head><title>Sign in</title>"));
  assert.equal(result.status, "degraded");
  assert.match(result.note, /wrong URL/);
});

test("an unreachable gateway reports the real errno, not just 'fetch failed'", async () => {
  // Undici hides `ECONNREFUSED`/`ENOTFOUND` in `error.cause` and reports the
  // bare string "fetch failed" at the top level. An `unknown` row whose reason
  // is "fetch failed" says something broke without saying what, which makes
  // "the host is gone" and "the port moved" indistinguishable in the report.
  // A high unused loopback port refuses the connection without needing DNS or
  // a network. (Not port 9 — undici blocks it as a "bad port" before dialling,
  // which is a different error with no errno.)
  const probe = await probeEndpoint("http://127.0.0.1:45987/ready", 5_000);
  assert.equal(probe.outcome, "unreachable");
  if (probe.outcome !== "unreachable") return;
  assert.match(probe.error, /ECONNREFUSED/);
});

test("an unreachable gateway costs ONE unknown row with a reason, and never throws", () => {
  const result = evaluate({ outcome: "unreachable", error: "getaddrinfo ENOTFOUND cubby.lan" });
  assert.equal(result.status, "unknown");
  assert.equal(result.httpStatus, null);
  assert.match(result.note, /ENOTFOUND/, "the reason survives into the report");
  assert.deepEqual(result.advisories, []);
});

// ---------------------------------------------------------------------------
// Forward compatibility — the contract, not today's exact JSON
// ---------------------------------------------------------------------------

test("unknown fields are ignored, not treated as failures", () => {
  const result = evaluate(
    responded(200, {
      status: "ok",
      backends: [{ name: "cosyvoice", reachable: true, status_code: 200, some_future_field: 42 }],
      diarization: { loaded: true, device: "cuda:0", load_error: null },
      a_field_nobody_has_shipped_yet: { nested: ["anything"] },
    })
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.advisories, []);
});

test("diarization on CPU is a warning, never a failure", () => {
  // ~23x slower than GPU (infra-cubby#176) and worth reading, but a report
  // that went red for it would go red on any host without a GPU.
  const result = evaluate(
    responded(200, { status: "ok", backends: [], diarization: { loaded: true, device: "cpu" } })
  );
  assert.equal(result.status, "ok", "an advisory does not change the verdict");
  assert.equal(result.advisories.length, 1);
  assert.match(result.advisories[0]!, /CPU/);
});

test("a payload with no diarization field yet produces no advisory", () => {
  // The field is being added concurrently; today's live payload has none.
  const result = evaluate(responded(200, liveOkBody));
  assert.deepEqual(result.advisories, []);
});

test("a failed or unloaded diarizer is surfaced as a warning", () => {
  const unloaded = evaluate(
    responded(200, { status: "ok", backends: [], diarization: { loaded: false, device: "cpu" } })
  );
  assert.equal(unloaded.status, "ok");
  assert.ok(unloaded.advisories.some((a) => /not loaded/.test(a)));

  const errored = evaluate(
    responded(200, {
      status: "ok",
      backends: [],
      diarization: { loaded: false, device: "cuda", load_error: "pyannote EULA not accepted" },
    })
  );
  assert.ok(errored.advisories.some((a) => /EULA/.test(a)));
});

test("a 404 on a backend's base URL is not treated as an outage", () => {
  // These backends are probed with a bare GET `/`, where 404 just means "no
  // route at the root" — the server is up. Today's live payload looks exactly
  // like this, and flagging it would be a daily false alarm.
  const result = evaluate(responded(200, liveOkBody));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.advisories, []);
});

test("`ok` while naming a dead backend is called out", () => {
  // A gateway that says it is fine while reporting an unreachable backend is
  // disagreeing with itself, and nothing else in the report would show it.
  const result = evaluate(
    responded(200, { status: "ok", backends: [{ name: "cosyvoice", reachable: false }] })
  );
  assert.ok(result.advisories.some((a) => /cosyvoice/.test(a)));
});

// ---------------------------------------------------------------------------
// Rollup and rendering — a voice failure has to be legible, not just present
// ---------------------------------------------------------------------------

const endpoint = (over: Partial<EndpointResult> = {}): EndpointResult => ({
  name: "voice-gateway /ready",
  url: "http://cubby.lan:8885/ready",
  status: "ok",
  httpStatus: 200,
  note: 'status="ok"',
  advisories: [],
  ...over,
});

const healthyGroup = {
  name: "cubby",
  status: "healthy" as const,
  expected: ["voice-gateway"],
  running: ["voice-gateway"],
  missing: [],
  note: "all critical containers are running",
};

test("a not-ready endpoint turns the whole report degraded", () => {
  const { overallStatus } = rollUp(
    [{ name: "Claude CLI", status: "up-to-date", current: "1", latest: "1", note: "" }],
    [healthyGroup],
    [],
    [endpoint({ status: "degraded", httpStatus: 503, note: 'status="unhealthy"' })]
  );
  assert.equal(overallStatus, "degraded");
});

test("an unreachable endpoint is a warning, not a red report", () => {
  const { overallStatus, warnings } = rollUp(
    [{ name: "Claude CLI", status: "up-to-date", current: "1", latest: "1", note: "" }],
    [healthyGroup],
    [],
    [endpoint({ status: "unknown", httpStatus: null, note: "could not reach it: ETIMEDOUT" })]
  );
  assert.equal(overallStatus, "healthy", "'could not tell' is not 'it is broken'");
  assert.ok(warnings.some((w) => /ETIMEDOUT/.test(w)), "but the reason is still reported");
});

test("an advisory alone does not change the overall status", () => {
  const { overallStatus } = rollUp(
    [],
    [healthyGroup],
    [],
    [endpoint({ advisories: ["diarization is running on CPU, not GPU"] })]
  );
  assert.equal(overallStatus, "healthy");
});

const report = (endpointResults: EndpointResult[]): InfraHealthReport => ({
  date: "2026-08-19",
  generated_at: "2026-08-19T14:00:00.000Z",
  repoRoot: null,
  cliResults: [],
  serviceResults: [healthyGroup],
  repoResults: [],
  endpointResults,
  ...rollUp([], [healthyGroup], [], endpointResults),
});

test("a voice failure is visible in every rendered destination", () => {
  const broken = report([
    endpoint({ status: "degraded", httpStatus: 503, note: 'status="unhealthy" — backends not serving: cosyvoice' }),
  ]);

  const text = buildSlackText(broken);
  assert.match(text, /Endpoint readiness/);
  assert.match(text, /voice-gateway \/ready/);
  assert.match(text, /cosyvoice/);

  const blocks = JSON.stringify(buildSlackBlocks(broken));
  assert.match(blocks, /Endpoint readiness/);
  assert.match(blocks, /cosyvoice/);
  assert.match(blocks, /degraded/);

  const markdown = buildMarkdown(broken);
  assert.match(markdown, /## Endpoint readiness/);
  assert.match(markdown, /cosyvoice/);
  assert.match(markdown, /503/);
});

test("advisories reach the reader without being filed under 'could not determine'", () => {
  const advised = report([endpoint({ advisories: ["diarization is running on CPU, not GPU"] })]);
  assert.equal(advised.warnings.length, 0, "an advisory is not a 'could not determine'");
  assert.match(buildSlackText(advised), /diarization is running on CPU/);
  assert.match(JSON.stringify(buildSlackBlocks(advised)), /diarization is running on CPU/);
  assert.match(buildMarkdown(advised), /diarization is running on CPU/);
});

test("a report gathered before endpoint checks existed still renders", () => {
  // `infra-health-deliver` is explicitly re-runnable against an older report,
  // which will not carry `endpointResults`.
  const legacy = { ...report([]) } as Partial<InfraHealthReport>;
  delete legacy.endpointResults;
  const old = legacy as InfraHealthReport;

  assert.match(buildSlackText(old), /\(no endpoint results\)/);
  assert.doesNotThrow(() => buildSlackBlocks(old));
  assert.match(buildMarkdown(old), /## Endpoint readiness/);
});

test("Slack sections stay under the 3000-char hard limit", () => {
  // Over 3000 Slack rejects the whole message with `invalid_blocks` — the
  // watchdog going silent exactly when it has the most to say.
  const noisy = report([
    endpoint({ status: "degraded", note: "x".repeat(4000), advisories: ["y".repeat(4000)] }),
  ]);
  for (const block of buildSlackBlocks(noisy) as Array<{ type: string; text?: { text: string } }>) {
    if (block.type === "section") {
      assert.ok(block.text!.text.length <= 3000, `section was ${block.text!.text.length} chars`);
    }
  }
});
