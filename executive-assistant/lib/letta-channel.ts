/**
 * Client for a Letta Code channel bridge (`wiki-stream`, bonker
 * `apps/letta-code-channels/channels/wiki-stream`): the house transport for
 * anything that talks to a Letta agent (ADR-057, `letta-channels` skill).
 *
 * The mermaid pipeline's LLM work goes through this instead of the completion
 * gateway's `/v1/chat/completions`. One POST per turn; the bridge answers with
 * a named-event SSE stream (`thinking` / `token` / `keepalive` / `done` /
 * `error`) and this client returns the `done` text. There is no fallback to a
 * direct completion path: an `error` frame, a non-2xx, a stream that closes
 * without `done`, or an idle timeout all throw.
 *
 * Identity: the bearer is the bridge's shared secret and identifies this
 * backend as a service. `email` is forwarded only when the caller has a real
 * one; nothing is invented when it does not.
 */

const DEFAULT_TIMEOUT_MS = 580_000; // strictly above the bridge's own idle timeout

export type LettaChannelConfig = {
  /** e.g. http://host.docker.internal:4800 — no trailing slash, no /turn. */
  url: string;
  token: string;
  /** wiki-stream tags each route with a mode; mermaid is its own. */
  mode?: string;
  timeoutMs?: number;
};

export type LettaChannelTurn = {
  /** Stable key for one Letta conversation. One in-flight turn per key. */
  conversationKey: string;
  text: string;
  email?: string;
};

export function lettaChannelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LettaChannelConfig {
  const url = env.MERMAID_LETTA_CHANNEL_URL;
  const token = env.LETTA_CHANNEL_BRIDGE_TOKEN;
  if (!url) throw new Error("MERMAID_LETTA_CHANNEL_URL is not set (the wiki-stream bridge, e.g. http://host.docker.internal:4800)");
  if (!token) throw new Error("LETTA_CHANNEL_BRIDGE_TOKEN is not set");
  return { url, token, mode: env.MERMAID_LETTA_CHANNEL_MODE ?? "mermaid" };
}

/** Parse one SSE block ("event: x\ndata: {...}") into its name and JSON data. */
export function parseSseBlock(block: string): { event: string; data: Record<string, unknown> } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment (": open")
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
}

export async function completeViaLettaChannel(
  turn: LettaChannelTurn,
  config: LettaChannelConfig = lettaChannelConfigFromEnv()
): Promise<string> {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/turn`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: turn.conversationKey,
      mode: config.mode ?? "mermaid",
      text: turn.text,
      ...(turn.email ? { email: turn.email } : {}),
    }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Letta channel error: ${res.status} ${await res.text()}`);
  if (!res.body) throw new Error("Letta channel returned no body");

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = parseSseBlock(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      if (!frame) continue;
      if (frame.event === "error") {
        throw new Error(`Letta channel turn failed: ${String(frame.data.message ?? JSON.stringify(frame.data))}`);
      }
      if (frame.event === "done") {
        const text = frame.data.text;
        if (typeof text !== "string") throw new Error(`Letta channel done frame had no text: ${JSON.stringify(frame.data)}`);
        return text;
      }
    }
  }
  throw new Error("Letta channel stream closed without a done frame");
}
