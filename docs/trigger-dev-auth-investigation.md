# trigger.dev self-hosted auth — investigation

Repo: `/home/jaewilson07/GitHub/trigger.dev` @ `feat/datacrew-sso`
Instance: `ghcr.io/triggerdotdev/trigger.dev:v4.5.7-datacrew-sso`, `https://triggers.datacrew.space` / `http://127.0.0.1:8030`
Project: `proj_noaaludkbpoorzosejyn` (`executive-assistant`)

## TL;DR

The DataCrew SSO work touches **only the browser/dashboard session path**. The programmatic
API is untouched stock trigger.dev: `Authorization: Bearer tr_<envslug>_<20 chars>`.
The production secret key for this project already exists in Postgres in plaintext.

```bash
curl -X POST http://127.0.0.1:8030/api/v1/tasks/hello-observability/trigger \
  -H "Authorization: Bearer tr_prod_E6OW9OhA7FraC8bspelX" \
  -H "Content-Type: application/json" \
  -d '{"payload":{"message":"hi"}}'
```

Verified live during this investigation (see "Verification" at the bottom).

---

## 1. How the custom SSO works

Four separate mechanisms live on this branch. **None of them apply to `/api/*`.**

### 1a. DataCrew SSO handoff — `GET /auth/datacrew?token=<jwt>`

`apps/webapp/app/routes/auth.datacrew.tsx`

- datacrew.space mints a short-lived **RS256** JWT (`/api/sso/trigger-dev`).
- This app verifies it against datacrew.space's **public JWKS** — no shared secret on this side
  (`auth.datacrew.tsx:72-76`, `services/datacrewSso.server.ts`).
- Checks issuer (`DATACREW_SSO_ISSUER`), audience (`DATACREW_SSO_AUDIENCE`), a `resource` claim,
  and expiry.
- **Single-use replay guard**: `jti` is `SET NX` into Redis with a TTL capped to the token's own
  `exp` (`auth.datacrew.tsx:57-61`). A second redemption is rejected even inside the validity window.
- On success it calls `findOrCreateMagicLinkUser` and sets a **normal trigger.dev session cookie**
  (`auth.datacrew.tsx:98-130`). MFA is honoured exactly as the magic-link callback does.

### 1b. Cloudflare Access zero-click sign-in

`apps/webapp/app/services/cloudflareAccess.server.ts` (verifier),
`apps/webapp/app/services/cloudflareAccessAutoSignIn.server.ts` (the sign-in attempt)

- Verifies the `Cf-Access-Jwt-Assertion` header against `<team-domain>/cdn-cgi/access/certs`.
- Team domain is `https://datacrew-space.cloudflareaccess.com` — **note the hyphen**; the
  no-hyphen tenant is real but publishes different keys, so a wrong value fails as
  "every assertion has a bad signature" (`env.server.ts:271-282`).
- Requires `CLOUDFLARE_ACCESS_AUD_TAG` (this app's own audience tag). Unset ⇒ feature is **off**
  (fails closed), no default (`env.server.ts:284-305`).

### 1c. Entitlement check (authorization half)

`apps/webapp/app/services/datacrewEntitlements.server.ts`

- Verified-but-unentitled visitors are sent to `DATACREW_ACCESS_REQUEST_URL`.
- Calls `DATACREW_ENTITLEMENTS_URL` with `DATACREW_ENTITLEMENTS_SECRET` and an
  `X-Entitlement-Subject` header (commit `68e6479aa`). Unset secret ⇒ auto-sign-in **off**.

### 1d. Where auto sign-in hooks in — and why the API is unaffected

`apps/webapp/app/services/session.server.ts:92-104`:

```ts
if (!authUser?.userId) {
  const autoSignIn = await attemptCloudflareAccessAutoSignIn(request, authUser);
  if (autoSignIn) throw autoSignIn;
}
```

This sits inside `getUserId()` — the **cookie-session** path used by `root.tsx` and
`requireUser*`. API routes never call it; they go through
`apps/webapp/app/services/routeBuilders/apiBuilder.server.ts` →
`apiAuth.server.ts`, which only reads the `Authorization` header.

**Consequence:** SSO is irrelevant to programmatic triggering. Also confirmed the public
hostname does not put Cloudflare Access in front of `/api/*` — a bearer request to
`https://triggers.datacrew.space/api/v1/runs` returned `200`, not an Access redirect.

---

## 2. How API tokens are generated and validated

### Token types (`apiAuth.server.ts:279-328`)

| Prefix | Type | Scope | Storage |
|---|---|---|---|
| `tr_prod_` / `tr_dev_` / `tr_stg_` / `tr_preview_` | secret key (`PRIVATE`) | one environment | **plaintext** in `RuntimeEnvironment.apiKey` |
| `pk_...` | publishable (`PUBLIC`) | one environment, read-mostly | plaintext in `RuntimeEnvironment.pkApiKey` (deprecated) |
| `tr_pat_` | Personal Access Token | one **user**, across orgs | encrypted (`ENCRYPTION_KEY`) in `PersonalAccessToken.encryptedToken` |
| `tr_oat_` | Organization Access Token | one org | encrypted |
| JWT (`PUBLIC_JWT`) | short-lived, minted per run | scoped claims | not stored |

Format: `` `tr_${envSlug(type)}_${apiKeyId(20)}` `` — `apps/webapp/app/models/api-key.server.ts:97-103`.
PAT format: `` `tr_pat_${40 chars}` `` — `personalAccessToken.server.ts:11-13, 463-467`.

### Validation path

1. `getApiKeyFromRequest` strips `Bearer ` — `apiAuth.server.ts:297-314`.
2. `getApiKeyResult` classifies by prefix; **unknown prefixes fall through to `PRIVATE`**
   — `apiAuth.server.ts:316-328`.
3. `PRIVATE` ⇒ `findEnvironmentByApiKey` (a plain DB lookup on the unique `apiKey` column).
4. Optional `x-trigger-branch` header selects a preview branch (`branchNameFromRequest`,
   `apiAuth.server.ts:293-295`).
5. RBAC gate runs afterwards in `apiBuilder.server.ts:331-348`. On OSS the fallback ability is
   permissive, so an env secret key passes.

### Getting a token

**Option A — read the existing env secret key from Postgres (fastest, no UI):**

```bash
docker exec trigger-postgres-1 psql -U postgres -d main -t -A -F'|' -c \
 "select e.slug, e.\"apiKey\" from \"Project\" p
    join \"RuntimeEnvironment\" e on e.\"projectId\"=p.id
   where p.\"externalRef\"='proj_noaaludkbpoorzosejyn';"
```

Actual values on this instance right now:

| env | key |
|---|---|
| prod | `tr_prod_E6OW9OhA7FraC8bspelX` |
| dev | `tr_dev_ojRl0e8DrBpUF7t5gdH3` |
| stg | `tr_stg_6TDmQm5MsDf6xPp7ycrZ` |
| preview | `tr_preview_6XSrCmPThp1S4RcWGill` |

> These are live production credentials. Treat this file accordingly.

**Option B — dashboard:** Project → Environment → API keys (same values), or
`/account/tokens` for a PAT (`apps/webapp/app/routes/account.tokens/`).

**Option C — CLI device flow:** `POST /api/v1/authorization-code` then poll
`GET /api/v1/token` (`packages/cli-v3/src/apiClient.ts:117,125`). This mints a PAT.

There is **no unauthenticated endpoint that mints a token**. PATs are encrypted at rest, so you
cannot read one out of Postgres without `ENCRYPTION_KEY` + the decrypt routine
(`personalAccessToken.server.ts:478-492`).

---

## 3. REST endpoint for triggering tasks

```
POST /api/v1/tasks/{taskIdentifier}/trigger
```

Route file: `apps/webapp/app/routes/api.v1.tasks.$taskId.trigger.ts`
Docs: `docs/management/tasks/trigger.mdx`

Auth: `Authorization: Bearer tr_<env>_...`. **Secret key only** — a PAT does *not* work for
triggering (`docs/management/authentication.mdx` support table: `task.trigger` ✅ secret key,
blank for PAT).

Body (`packages/core/src/v3/schemas/api.ts:203-297`):

```json
{
  "payload": { "any": "json" },
  "context": {},
  "options": {
    "queue": { "name": "..." },
    "concurrencyKey": "...",
    "delay": "10s",
    "idempotencyKey": "...",
    "idempotencyKeyTTL": "1h",
    "machine": "small-1x",
    "maxAttempts": 3,
    "maxDuration": 300,
    "metadata": {},
    "tags": ["a", "b"],
    "ttl": "1h",
    "priority": 0,
    "test": false
  }
}
```

Useful request headers (`api.v1.tasks.$taskId.trigger.ts:32-48`):
`idempotency-key`, `idempotency-key-ttl`, `x-trigger-request-idempotency-key`,
`x-trigger-branch`, `traceparent`.

Response `200`:

```json
{ "id": "run_cmse6v...", "isCached": false }
```

Plus headers `x-trigger-jwt` and `x-trigger-jwt-claims` — a 1-hour public JWT scoped to
`read:runs:<runId>` so a browser can subscribe to that run without the secret key
(`api.v1.tasks.$taskId.trigger.ts:186-209`).

Related endpoints:
- `POST /api/v1/tasks/batch` — batch trigger (`api.v1.tasks.batch.ts`)
- `GET /api/v1/runs?limit=N` — list runs (`api.v1.runs.ts`)
- `GET /api/v3/runs/{runId}` — retrieve a run
- `POST /api/v2/runs/{runId}/cancel` — cancel (note: **v2**, not v1; v1 404s)
- `GET /api/v1/whoami` — identity check (PAT-oriented)

### Gotcha: unknown task ids still create a run

`POST /api/v1/tasks/__does-not-exist__/trigger` returned **200** with a real run id, not 404.
Run Engine 2.0 queues the run and waits for a worker that can claim it. Validate task
identifiers client-side; a typo produces a pending run, not an error.

Deployed task identifiers on `prod` (worker `20260802.7`) include: `hello-observability`,
`email-digest`, `triage-emails`, `fetch-emails`, `post-slack`, `enrich-greeting`,
`search-topics`, `mdrag-extract-results`, `mdrag-critique`, `mdrag-search-providers`,
`mdrag-synthesize`, `pattern-hunter-full-run`, `pattern-hunter-red-team`,
`pattern-hunter-hypotheses`, `pattern-hunter-context-snapshot`.

---

## 4. Environment variables

**There is no `TRIGGER_SECRET`.** The names that matter:

### Client side (what you set to call the API)

| Var | Value | Read at |
|---|---|---|
| `TRIGGER_SECRET_KEY` | `tr_prod_E6OW9OhA7FraC8bspelX` | `packages/core/src/v3/apiClientManager/index.ts:62` |
| `TRIGGER_API_URL` | `http://127.0.0.1:8030` (or `https://triggers.datacrew.space`) | `apiClientManager/index.ts:50` — **must be set**, defaults to `https://api.trigger.dev` |
| `TRIGGER_ACCESS_TOKEN` | `tr_pat_...` — CLI / management API only | `packages/cli-v3/src/commands/login.ts:120` |

`TRIGGER_SECRET_KEY` and `TRIGGER_ACCESS_TOKEN` are checked in that order and both land in the
same `accessToken` slot (`apiClientManager/index.ts:62-63`) — the server distinguishes them by prefix.

### Server side (already set in `hosting/docker/webapp/docker-compose.yml`)

Auth-relevant: `SESSION_SECRET`, `MAGIC_LINK_SECRET`, `ENCRYPTION_KEY` (encrypts PATs/OATs),
`APP_ORIGIN` / `LOGIN_ORIGIN` / `API_ORIGIN`.

SSO-specific (lines 74-91), none needed for API access:
`DATACREW_JWKS_URL`, `DATACREW_SSO_ISSUER`, `DATACREW_SSO_AUDIENCE`,
`CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_AUD_TAG`, `DATACREW_ENTITLEMENTS_SECRET`.

---

## 5. Recommended approach

**Use the production environment secret key with a plain HTTP POST.** No SSO, no PAT, no
token-exchange dance.

```bash
export TRIGGER_API_URL=http://127.0.0.1:8030
export TRIGGER_SECRET_KEY=tr_prod_E6OW9OhA7FraC8bspelX

curl -sX POST "$TRIGGER_API_URL/api/v1/tasks/hello-observability/trigger" \
  -H "Authorization: Bearer $TRIGGER_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -H "idempotency-key: my-stable-key-001" \
  -d '{"payload":{"message":"hi"},"options":{"tags":["from-script"]}}'
```

Or via the SDK (no task definitions needed on the caller side):

```ts
import { configure, tasks } from "@trigger.dev/sdk";

configure({
  baseURL: process.env.TRIGGER_API_URL,
  secretKey: process.env.TRIGGER_SECRET_KEY,
});

const handle = await tasks.trigger("hello-observability", { message: "hi" });
```

Notes:

1. **Prefer `127.0.0.1:8030`** for server-to-server calls on bonker — it skips Caddy and
   Cloudflare entirely. The public hostname also works for bearer-authed API calls (verified),
   but that path depends on Access config staying permissive for `/api/*`.
2. **Always send an `idempotency-key`.** The trigger endpoint is a POST with no natural dedupe;
   a retried request creates a second run without one.
3. **Don't use a PAT for triggering** — PATs authenticate but the trigger endpoint is
   secret-key-only.
4. **Rotate if leaked**: `POST /api/v1/projects/{projectRef}/{env}/regenerate-api-key`
   (`apps/webapp/app/routes/api.v1.projects.$projectRef.$env.regenerate-api-key.ts`), or the
   dashboard. Rotation invalidates any worker/CI using the old key.
5. Poll results with `GET /api/v3/runs/{runId}`, or use the `x-trigger-jwt` from the trigger
   response for realtime subscription from a browser.

---

## Verification performed

Read-only probes against the live instance, `2026-08-03`:

| Check | Result |
|---|---|
| `GET /api/v1/runs?limit=1` with no auth | `401` |
| `GET /api/v1/runs?limit=1` with `tr_prod_...` | `200` |
| Same via `https://triggers.datacrew.space` | `200` (no Access redirect) |
| `POST /api/v1/tasks/__does-not-exist__/trigger` | `200`, created `run_cmse6v76f00084ilac3k4rov9` |
| `POST /api/v2/runs/run_cmse6v76f00084ilac3k4rov9/cancel` | `200` — probe run cancelled, nothing left pending |

No files in the repo were modified.
