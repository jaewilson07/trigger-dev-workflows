/**
 * Client for mermaid-api's pipeline endpoint (infra-bonker `apps/mermaid-api`,
 * datacrew-site#247): `POST ${MERMAID_API_URL}/v1/pipeline/turn` with a
 * service bearer and `{run_id, text}`, answered by `{reply}`. mermaid-api
 * relays the turn to EmmaBot through the mermaid-stream Letta channel under
 * the key `mermaid-pipeline:run:<run_id>` and buffers the stream, so this
 * client sees plain JSON.
 *
 * Failures are named, not generic: auth (401/403), turn in flight (409),
 * upstream turn failed (502), any other non-2xx, and bad configuration. They
 * propagate; nothing here retries or falls back.
 */

const DEFAULT_API_URL = "http://mermaid-api:8000";
const DEFAULT_TIMEOUT_MS = 580_000; // runners have no 100 s edge; allow a long agent turn

export type MermaidPipelineConfig = {
  /** e.g. http://mermaid-api:8000 — no /v1 path. */
  url: string;
  token: string;
  timeoutMs?: number;
};

export type PipelineTurn = {
  /** The pipeline run's id; one Letta conversation per run. */
  runId: string;
  text: string;
};

export class MermaidPipelineConfigError extends Error {
  override name = "MermaidPipelineConfigError";
}

export class MermaidPipelineAuthError extends Error {
  override name = "MermaidPipelineAuthError";
  constructor(public readonly status: number, detail: string) {
    super(`mermaid-api rejected the pipeline token (${status}): ${detail}`);
  }
}

/** 409: a turn for this run id is already in flight. */
export class MermaidPipelineTurnInFlightError extends Error {
  override name = "MermaidPipelineTurnInFlightError";
  constructor(public readonly runId: string, detail: string) {
    super(`a mermaid pipeline turn for run ${runId} is already in flight: ${detail}`);
  }
}

/** 502: the bridge or the agent turn failed behind mermaid-api. */
export class MermaidPipelineUpstreamError extends Error {
  override name = "MermaidPipelineUpstreamError";
  constructor(detail: string) {
    super(`mermaid-api pipeline turn failed upstream (502): ${detail}`);
  }
}

/** Any other non-2xx, or a 2xx whose body is not `{reply: string}`. */
export class MermaidPipelineHttpError extends Error {
  override name = "MermaidPipelineHttpError";
  constructor(public readonly status: number, detail: string) {
    super(`mermaid-api pipeline turn error (${status}): ${detail}`);
  }
}

/**
 * MERMAID_PIPELINE_TOKEN is baked into the deploy by trigger.config.ts's
 * SYNCED_SECRETS (Infisical `/mermaid-api`). MERMAID_API_URL is plain config
 * and defaults to the container name on ai-network.
 */
export function mermaidPipelineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MermaidPipelineConfig {
  const token = env.MERMAID_PIPELINE_TOKEN;
  if (!token) {
    throw new MermaidPipelineConfigError(
      "MERMAID_PIPELINE_TOKEN is not set (expected from Infisical /mermaid-api via trigger.config.ts SYNCED_SECRETS)"
    );
  }
  return { url: env.MERMAID_API_URL || DEFAULT_API_URL, token };
}

async function detailOf(res: Response): Promise<string> {
  const raw = await res.text();
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON; fall through to the raw text
  }
  return raw.slice(0, 500);
}

export async function runPipelineTurn(
  turn: PipelineTurn,
  config: MermaidPipelineConfig = mermaidPipelineConfigFromEnv()
): Promise<string> {
  if (!turn.runId) throw new MermaidPipelineConfigError("a pipeline turn needs a run id (ctx.run.id); got an empty one");
  const res = await fetch(`${config.url.replace(/\/$/, "")}/v1/pipeline/turn`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: turn.runId, text: turn.text }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await detailOf(res);
    if (res.status === 401 || res.status === 403) throw new MermaidPipelineAuthError(res.status, detail);
    if (res.status === 409) throw new MermaidPipelineTurnInFlightError(turn.runId, detail);
    if (res.status === 502) throw new MermaidPipelineUpstreamError(detail);
    throw new MermaidPipelineHttpError(res.status, detail);
  }
  const body = (await res.json()) as { reply?: unknown };
  if (typeof body.reply !== "string") {
    throw new MermaidPipelineHttpError(res.status, `response had no string "reply": ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.reply;
}
