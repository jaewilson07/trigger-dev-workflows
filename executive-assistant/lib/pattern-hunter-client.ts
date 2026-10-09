/**
 * Thin HTTP client for Pattern Hunter's own FastAPI service
 * (`projects/pattern-hunter/main.py`) — `POST /context-snapshot`,
 * `/pain-points`, `/hypotheses`, `/red-team`, `/brief`, `/publish/gdoc`.
 * Mirrors `lib/mdrag-primitives.ts`'s `postMdragPrimitive` shape
 * (datacrew#298), but this is a DIFFERENT backend: Pattern Hunter's own
 * service, not mdrag directly (Pattern Hunter itself calls mdrag's
 * `/api/v1/primitives` router internally for Nodes 2/3/5 — see `main.py`'s
 * module docstring — this client never talks to mdrag).
 *
 * ## Auth
 *
 * NONE, except ONE route (datacrew#338 UPDATE — read this before assuming
 * the paragraph below still applies to every route). Confirmed by reading
 * `projects/pattern-hunter/main.py` in full: every route EXCEPT
 * `POST /publish/gdoc` (`context_snapshot`, `pain_points`, `hypotheses`,
 * `red_team`, `brief`) is a plain `@app.post(...)` handler with no
 * `Depends(...)` security scheme and no API-key/auth middleware registered
 * on the `FastAPI` app (contrast mdrag's `ApiKeyMiddleware`, which
 * `postMdragPrimitive` authenticates against via `X-DC-Token`). This is a
 * genuine, currently-true gap for THOSE routes, not an oversight in this
 * client — see `PATTERN_HUNTER_URL`'s doc comment below and this PR's
 * description for why it's acceptable for now (the service isn't exposed
 * publicly — see the header comment of infra-bonker's
 * `apps/pattern-hunter/docker-compose.yml`) and what needs to happen before it would be unsafe to leave open.
 *
 * `POST /publish/gdoc` (datacrew#338) is DIFFERENT: it's gated by a required
 * `X-Publish-API-Key` header (`main.py`'s `_require_publish_api_key`)
 * because, given just a `user_id` string, it will write into a real
 * person's Google Drive using their real stored OAuth credential — the one
 * route in this file where "no auth, not exposed publicly" isn't a
 * sufficient posture on its own. `postPatternHunter`'s optional
 * `extraHeaders` parameter exists specifically so
 * `tasks/research/pattern-hunter-publish-gdoc.ts` can supply that header without
 * every other call site needing to pass an empty object.
 */

/**
 * Base URL for Pattern Hunter's FastAPI service.
 *
 * Defaults to the `pattern-hunter` container on bonker's `ai-network`, the
 * same way `completion-gateway.ts` and `letta-gateway.ts` default to their
 * container DNS names: the supervisor starts task containers on that network
 * (`DOCKER_RUNNER_NETWORKS=webapp,supervisor,ai-network`). The old
 * `localhost:8090` default never resolved inside a task container, so every
 * `pattern-hunter-context-snapshot` run failed with "fetch failed" (#225).
 * For a local `uvicorn main:app --port 8090` run, set
 * `PATTERN_HUNTER_URL=http://localhost:8090`.
 */
const PATTERN_HUNTER_URL = (process.env.PATTERN_HUNTER_URL ?? "http://pattern-hunter:8090").replace(
  /\/+$/,
  ""
);

export class PatternHunterError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly status: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = "PatternHunterError";
  }
}

/**
 * POST to one Pattern Hunter route (e.g. `"context-snapshot"`,
 * `"pain-points"`, `"publish/gdoc"`) and parse the JSON response. Throws
 * `PatternHunterError` on a non-2xx status or a non-JSON body — no silent
 * partial success (this repo's no-silent-failures convention). A non-2xx
 * that's actually an EXPECTED, well-formed outcome (e.g. `/publish/gdoc`'s
 * `409 consent_required`) is still thrown as `PatternHunterError` here —
 * callers that need to treat a specific status as non-fatal (see
 * `tasks/research/pattern-hunter-publish-gdoc.ts`) catch it and inspect `.status`,
 * rather than this shared function special-casing any one route's status
 * codes.
 *
 * `extraHeaders` (datacrew#338, optional, defaults to none) is ONLY needed
 * by `POST /publish/gdoc` today — see this file's module doc comment,
 * "Auth" section, for why that ONE route requires a shared-secret header
 * every other Pattern Hunter route does not.
 */
export async function postPatternHunter<TResponse>(
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>
): Promise<TResponse> {
  const url = `${PATTERN_HUNTER_URL}/${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new PatternHunterError(
      `pattern-hunter ${path} returned HTTP ${response.status}`,
      path,
      response.status,
      text
    );
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch {
    throw new PatternHunterError(
      `pattern-hunter ${path} returned a non-JSON body`,
      path,
      response.status,
      text
    );
  }
}
