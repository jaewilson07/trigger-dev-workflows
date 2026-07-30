/**
 * Searches tracked topics via the mdrag MCP `search_web` tool. Speaks the
 * FastMCP Streamable HTTP transport: POST `initialize` once to obtain an
 * `Mcp-Session-Id`, then POST `tools/call` with that session header for each
 * search. Responses are Server-Sent Events; each call parses the first
 * `data: {...}` line containing a JSON-RPC result.
 *
 * A DIFFERENT mdrag surface than `lib/mdrag-primitives.ts` (that one hits
 * the `/api/v1/primitives` REST router directly, no MCP session involved).
 * Same auth convention as that file: `X-DC-Token`, not `Authorization`,
 * because `wiki.datacrew.space` sits behind Cloudflare Access, which strips
 * `Authorization` on routes it fronts.
 *
 * Ported 1:1 from `scripts/brief_pipeline.py`'s `TopicSearcher` class.
 */

const MDRAG_URL = (process.env.MDRAG_URL ?? "https://wiki.datacrew.space").replace(/\/+$/, "");
const MDRAG_TOKEN = process.env.MDRAG_TOKEN ?? "";

export type TopicSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

export type TopicSearchResult = {
  topic: string;
  results: TopicSearchResultItem[];
  searched_at: string;
};

type McpEnvelope = {
  result?: unknown;
  error?: unknown;
};

class TopicSearcher {
  private sessionId: string | null = null;

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-DC-Token": MDRAG_TOKEN,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    return headers;
  }

  private async mcpPost(payload: unknown, timeoutMs: number): Promise<unknown> {
    const res = await fetch(`${MDRAG_URL}/mcp/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`mdrag MCP HTTP ${res.status}: ${await res.text()}`);
    }
    const sessionHeader = res.headers.get("Mcp-Session-Id");
    if (sessionHeader) {
      this.sessionId = sessionHeader;
    }

    const text = await res.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      let msg: McpEnvelope;
      try {
        msg = JSON.parse(line.slice("data: ".length));
      } catch {
        continue;
      }
      if ("result" in msg) return msg.result;
      if ("error" in msg) throw new Error(`mdrag MCP error: ${JSON.stringify(msg.error)}`);
    }
    throw new Error(`mdrag MCP: no result in response:\n${text.slice(0, 500)}`);
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    await this.mcpPost(
      {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "idrisbot-morning-brief", version: "0.1" },
        },
        id: 0,
      },
      15_000
    );
  }

  private async callSearchWeb(query: string, limit: number): Promise<string> {
    await this.ensureSession();
    const result = (await this.mcpPost(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "search_web", arguments: { query, limit } },
        id: 1,
      },
      30_000
    )) as { isError?: boolean; content?: Array<{ text?: string }> };

    if (result.isError) {
      throw new Error(`mdrag search_web returned error: ${JSON.stringify(result)}`);
    }
    return result.content?.[0]?.text ?? "";
  }

  /** Parses search_web's markdown-formatted numbered list into structured items. */
  private static parseResults(text: string, source: string): TopicSearchResultItem[] {
    const items: TopicSearchResultItem[] = [];
    const blocks = text.trim().split(/\n(?=\d+\.\s)/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length === 0 || !lines[0]) continue;

      const titleMatch = lines[0].match(/^\d+\.\s+\**(.+?)\**$/);
      const title = titleMatch?.[1] ?? lines[0];

      let url = "";
      const snippetParts: string[] = [];
      for (const line of lines.slice(1)) {
        const stripped = line.trim();
        if (stripped.toLowerCase().startsWith("url:")) {
          url = stripped.slice(stripped.indexOf(":") + 1).trim();
        } else if (stripped) {
          snippetParts.push(stripped);
        }
      }
      if (!url) continue;
      items.push({ title, url, snippet: snippetParts.join(" ").trim(), source });
    }
    return items;
  }

  async searchTopics(topics: string[], maxResultsPerTopic: number): Promise<TopicSearchResult[]> {
    const results: TopicSearchResult[] = [];
    for (const topic of topics) {
      const text = await this.callSearchWeb(topic, maxResultsPerTopic);
      results.push({
        topic,
        results: TopicSearcher.parseResults(text, "mdrag/searxng"),
        searched_at: new Date().toISOString(),
      });
    }
    return results;
  }
}

export async function searchTrackedTopics(
  topics: string[],
  maxResultsPerTopic: number
): Promise<TopicSearchResult[]> {
  if (!MDRAG_TOKEN) {
    throw new Error("MDRAG_TOKEN is not set — required to call mdrag's MCP search_web tool");
  }
  const searcher = new TopicSearcher();
  return searcher.searchTopics(topics, maxResultsPerTopic);
}
