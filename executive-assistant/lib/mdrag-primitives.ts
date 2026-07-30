/**
 * Thin HTTP client for mdrag's `POST /api/v1/primitives/*` router (mdrag#886,
 * PR #894) — `plan-research` / `synthesize` / `extract-results`. This is a
 * DIFFERENT mdrag surface than the MCP-based topic search
 * `tasks/search-topics.ts` calls via `brief_pipeline.py`'s `TopicSearcher`
 * (that hits `/mcp/`); this hits the primitives REST router directly over
 * plain HTTP, no MCP session involved.
 *
 * ## Auth
 *
 * mdrag's `ApiKeyMiddleware`
 * (`mdrag/src/interfaces/api/middleware/api_key.py`) gates every
 * `/api/v1/*` route behind a `dc_`-prefixed JWT, accepted via either
 * `Authorization: Bearer <token>` OR an `X-DC-Token: <token>` header — the
 * middleware's own docstring calls out `X-DC-Token` as the
 * Cloudflare-Access-safe alternative, since CF Access strips the
 * `Authorization` header on routes it fronts. `MDRAG_URL` defaults to
 * `wiki.datacrew.space`, which sits behind CF Access, and the existing MCP
 * call in this same project (`../scripts/brief_pipeline.py`'s
 * `TopicSearcher._headers`) already sends the same `MDRAG_TOKEN` value via
 * `X-DC-Token` for that exact reason. This client matches that established
 * convention rather than switching to `Authorization: Bearer`.
 *
 * `/api/v1/primitives/*` requires no route-specific scope beyond "valid
 * token" (only `/api/v1/mcp` and `/api/v1/logs` do), so the same
 * `MDRAG_TOKEN` already provisioned for topic search is directly reusable
 * here — no new env var needed.
 */

const MDRAG_URL = (process.env.MDRAG_URL ?? "https://wiki.datacrew.space").replace(/\/+$/, "");
const MDRAG_TOKEN = process.env.MDRAG_TOKEN ?? "";

export class MdragPrimitiveError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly status: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = "MdragPrimitiveError";
  }
}

/**
 * POST to one `/api/v1/primitives/<path>` route and parse the JSON response.
 * Throws `MdragPrimitiveError` on a non-2xx status or a non-JSON body —
 * no silent partial success (this repo's no-silent-failures convention).
 */
export async function postMdragPrimitive<TResponse>(
  path: string,
  body: unknown
): Promise<TResponse> {
  if (!MDRAG_TOKEN) {
    throw new Error(
      "MDRAG_TOKEN is not set — required to call mdrag's /api/v1/primitives router"
    );
  }

  const url = `${MDRAG_URL}/api/v1/primitives/${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-DC-Token": MDRAG_TOKEN,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new MdragPrimitiveError(
      `mdrag primitives/${path} returned HTTP ${response.status}`,
      path,
      response.status,
      text
    );
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch {
    throw new MdragPrimitiveError(
      `mdrag primitives/${path} returned a non-JSON body`,
      path,
      response.status,
      text
    );
  }
}
