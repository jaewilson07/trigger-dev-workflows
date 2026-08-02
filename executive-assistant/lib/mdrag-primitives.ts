/**
 * Thin HTTP client for mdrag's `POST /api/v1/primitives/*` router (mdrag#886,
 * PR #894) — `plan-research` / `synthesize` / `extract-results` / `critique` /
 * `search-providers`. Hits the primitives REST router directly over plain HTTP,
 * no MCP session involved. Topic search (`lib/mdrag-topic-search.ts`) now goes
 * through this same client (via `search-providers`) rather than the old
 * FastMCP `search_web` path.
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
 * `wiki.datacrew.space`, which sits behind CF Access, so this client sends
 * `MDRAG_TOKEN` via `X-DC-Token` rather than `Authorization: Bearer`.
 *
 * `/api/v1/primitives/*` requires no route-specific scope beyond "valid
 * token" (only `/api/v1/mcp` and `/api/v1/logs` do), so the same
 * `MDRAG_TOKEN` already provisioned for topic search is directly reusable
 * here — no new env var needed.
 */

import type { paths } from "./mdrag-schema.js";

const MDRAG_URL = (process.env.MDRAG_URL ?? "https://wiki.datacrew.space").replace(/\/+$/, "");
const MDRAG_TOKEN = process.env.MDRAG_TOKEN ?? "";

/**
 * The `/api/v1/primitives/*` surface, keyed by the short name callers pass to
 * {@link callMdragPrimitive}. The full OpenAPI path is the source of truth for
 * both the request body and the 200 response type, generated into
 * `mdrag-schema.ts` — so a field rename in mdrag's Pydantic models becomes a
 * compile error here instead of a silent runtime mismatch (trigger#9).
 */
type PrimitivePath = {
  "plan-research": "/api/v1/primitives/plan-research";
  synthesize: "/api/v1/primitives/synthesize";
  "extract-results": "/api/v1/primitives/extract-results";
  critique: "/api/v1/primitives/critique";
  "search-providers": "/api/v1/primitives/search-providers";
};

export type MdragPrimitiveRequest<K extends keyof PrimitivePath> =
  paths[PrimitivePath[K]]["post"]["requestBody"]["content"]["application/json"];

export type MdragPrimitiveResponse<K extends keyof PrimitivePath> =
  paths[PrimitivePath[K]]["post"]["responses"][200]["content"]["application/json"];

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

/**
 * Typed wrapper over {@link postMdragPrimitive}: the `name` selects the endpoint,
 * and both `body` and the resolved return type are checked against mdrag's
 * generated OpenAPI schema. Prefer this over the raw `postMdragPrimitive` in
 * task code so request/response drift is caught at compile time.
 */
export async function callMdragPrimitive<K extends keyof PrimitivePath>(
  name: K,
  body: MdragPrimitiveRequest<K>
): Promise<MdragPrimitiveResponse<K>> {
  return postMdragPrimitive<MdragPrimitiveResponse<K>>(name, body);
}
