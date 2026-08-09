import { schedules, logger, tags } from "@trigger.dev/sdk";
import { getSecret } from "@datacrew/trigger-shared";

/**
 * Replaces the bonker cron `ingest-domo-docs.sh`
 * (`infra-bonker/.agents/runbooks/ingest-domo-docs/ingest-domo-docs.sh`,
 * `0 9 * * *`) — see jaewilson07/trigger-dev-workflows#31. The GitHub Action
 * of the same name (`datacrew/.github/workflows/ingest-domo-docs.yml`) was
 * already manual-dispatch-only (it needs a self-hosted runner on bonker to
 * reach localhost:8017, which was never registered), so this only retires
 * the cron script, not any active Action schedule.
 *
 * Single `schedules.task`, no composition, for the same reason
 * `crewRagDomoScrape.ts` is one task: fetch-SHA -> POST-ingest is linear,
 * nothing here needs `triggerAndWait`'s child-task fan-out, so there is no
 * reason to pay the extra `POST /api/v1/tasks/*\/trigger` hop (Turnstile-gated
 * for non-Bearer callers, though irrelevant to a self-triggering schedule).
 *
 * ---
 *
 * ## Decision 1: skip-if-unchanged gate — NOT implemented, on purpose
 *
 * The bash script persists the last-seen upstream SHA in
 * `~/.cache/domo-docs-ingest-last-sha`, a local file that has no equivalent
 * in an ephemeral Trigger.dev container (a fresh filesystem every run, no
 * shared volume). Two real options existed:
 *
 *   1. Query Trigger.dev's own Runs API (`runs.list`) for the most recent
 *      COMPLETED run of this task and read the SHA off its output, to
 *      reconstruct cross-run state without any external store.
 *   2. Always call the ingest endpoint and rely on mdrag's own
 *      upsert-on-source_url (ADR-0016) to absorb the redundancy.
 *
 * Went with (2). `POST /api/v1/ingest/git-repo` is genuinely idempotent per
 * source_url — a same-content re-ingest re-embeds the unchanged docs (real
 * but small cost: this repo's `s/article` subtree, once a day) rather than
 * corrupting or duplicating anything. (1) would have made this "actually
 * correct" in the sense of doing zero redundant work, but at the cost of a
 * `runs.list` call, response-shape coupling to this task's own prior output,
 * and a failure mode ("couldn't read run history, don't know if it changed")
 * that (2) simply doesn't have. The upstream SHA is still fetched and logged
 * below — not to gate on, but so a human reading the run history can see
 * whether that day's ingest actually corresponded to a real upstream change.
 *
 * ## Decision 2: auth — `DATACREW_API_TOKEN` (dc_ JWT Bearer), not
 * `X-Internal-Secret`
 *
 * The bash script authenticates via `docker exec mdrag-local printenv
 * INTERNAL_SECRET` — only possible because it runs ON bonker with Docker
 * access to the container. A trigger.dev task runs off-host, in an isolated
 * container with no such access.
 *
 * Read `mdrag`'s actual auth-checking code
 * (`src/interfaces/api/middleware/api_key.py`, `_is_internal_request`)
 * rather than assuming: the `X-Internal-Secret` bypass is a **pure string
 * comparison** against the `INTERNAL_SECRET` env var — there is no
 * localhost/trusted-network check anywhere in that path. So it is not
 * actually restricted to bonker-local callers; any caller presenting the
 * right header value would clear it. It was NOT chosen anyway, for two
 * independent reasons:
 *
 *   - `INTERNAL_SECRET` does not exist in Infisical at all (confirmed
 *     empirically: not present under `/datacrew`, `/mdrag`, or `/` in the
 *     shared org project) — it lives only in `infra-bonker`'s `.env` on the
 *     host. Using it here would mean adding a brand-new Infisical entry for
 *     a credential whose name and doc comments ("wiki -> mdrag
 *     server-to-server") signal host-local trust, even though the code
 *     doesn't enforce it — a bigger, easier-to-misjudge change than reusing
 *     an existing, already-remote-facing credential.
 *   - `DATACREW_API_TOKEN` is the documented, already-portable path for
 *     exactly this situation (`mdrag/.agents/guides/calling-mdrag-from-agents.md`):
 *     a no-expiry `dc_` service JWT, verified via `mdrag`'s JWKS-backed
 *     `verify_jwt_full` (issuer/audience checked, no network-origin check
 *     either), already stored in Infisical `/datacrew` (the same folder this
 *     project's `getSecret()` already defaults to), and already used by
 *     other off-host callers (Alix, the `use-mdrag` skill).
 *
 * Verified live (not assumed) before wiring this up: `Authorization: Bearer
 * <DATACREW_API_TOKEN>` against `GET https://wiki.datacrew.space/api/v1/mcp/tools`
 * (an mdrag-only route, same auth middleware as `/ingest/git-repo`) returned
 * `200` from an off-bonker caller over the public hostname.
 *
 * ## Decision 3: no `x-user-email` header — see jaewilson07/trigger-dev-workflows#36
 *
 * An earlier version of this task sent `x-user-email: jae@datacrew.space`,
 * on the assumption that `_resolve_owner_email` reads it directly. That
 * header never took effect, and cannot on this ingress path: `/api/v1/*` on
 * `wiki.datacrew.space` terminates at mdrag's own Next.js proxy
 * (`frontend/app/api/v1/[...path]/route.ts`), which treats `x-user-email` as
 * a **proxy-trust header** — it is unconditionally stripped from every
 * incoming request, then re-injected only when the proxy "vouches" for the
 * caller via an authenticated NextAuth session. `vouch` is defined as
 * `!callerCredentials`, and `callerCredentials` is true the instant a
 * request carries an `Authorization` header — which this task's Bearer
 * token always does. So a Bearer-authenticated caller can never be vouched
 * for on this path, by design (it's the anti-spoofing boundary that stops a
 * client from asserting someone else's identity), not a Caddy or Cloudflare
 * Tunnel misconfiguration (confirmed live: bypassing both entirely and
 * hitting the Next.js proxy directly still drops the header; hitting mdrag
 * directly, skipping the proxy, honors it).
 *
 * Deriving the owner from the JWT's own `email` claim instead — the
 * "properly fix passthrough" option — was considered and rejected:
 * `DATACREW_API_TOKEN`'s claims are `jaewilson07@gmail.com`, not
 * `jae@datacrew.space`. Those are two DISTINCT owner identities already in
 * use elsewhere in mdrag's collection registry, so deriving ownership from
 * the token would silently reassign this collection to the wrong owner
 * rather than fix anything.
 *
 * The collection this task ingests into (`repo_domoapps-domo-documentation-hub`)
 * is instead owned via mdrag's `default_owner_email` setting
 * (`jae@datacrew.space` as of this writing — confirmed live against the
 * running container, not just the repo default), and — decisively — via
 * `ensure_repo_collection`'s `$setOnInsert`: the owner is frozen at first
 * insert and cannot drift regardless of what any future caller sends. This
 * is intentionally a fixed service-owned collection, not a per-user one —
 * it's Domo's public documentation, not anyone's personal content, so a
 * single admin/service identity owning it is correct, not a stopgap. (This
 * is unrelated to Pattern Hunter's per-anonymous-user collection model —
 * that's a different mechanism, a client-held session id claimed on
 * registration, for a genuinely different kind of caller: an anonymous
 * browser visitor, not a Bearer-authenticated backend service.)
 */

const DOMO_DOCS_OWNER = "DomoApps";
const DOMO_DOCS_REPO = "domo-documentation-hub";
const DOMO_DOCS_GITHUB_URL = `https://github.com/${DOMO_DOCS_OWNER}/${DOMO_DOCS_REPO}/tree/main/s/article`;
// Scoped to `main` + the `s/article` subpath — the same subtree
// DOMO_DOCS_GITHUB_URL ingests — so the logged SHA actually corresponds to
// what got ingested, not just "something changed somewhere in the repo".
const DOMO_DOCS_LATEST_COMMIT_URL = `https://api.github.com/repos/${DOMO_DOCS_OWNER}/${DOMO_DOCS_REPO}/commits?sha=main&path=s/article&per_page=1`;

// Overridable so a dev/preview run can point at a non-prod mdrag without a
// code change. Defaults to the same canonical unified-gateway hostname
// `calling-mdrag-from-agents.md` documents for every off-host caller.
const MDRAG_API_URL = process.env.MDRAG_API_URL ?? "https://wiki.datacrew.space";

type DomoDocsIngestPayload = {
  // Same `Date | string` duality every schedules.task in this repo has to
  // handle (see docs/watchdog-rework.md) — a real Date from the scheduler,
  // a JSON string from a manual dashboard/API trigger.
  timestamp: Date | string;
  timezone: string;
};

type IngestOutcome = {
  status: "queued";
  jobId: string;
  statusUrl: string;
  latestSha: string | null;
};

async function safeAddTags(values: string[]): Promise<void> {
  try {
    await tags.add(values);
  } catch (error) {
    console.warn(
      "Skipping Trigger.dev tags outside managed runtime:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Best-effort: the latest upstream SHA is logged for observability only (see
 * Decision 1 above), so a fetch failure here must never block the actual
 * ingest — it just means that day's run can't say whether upstream moved.
 */
async function getLatestUpstreamSha(): Promise<string | null> {
  try {
    const response = await fetch(DOMO_DOCS_LATEST_COMMIT_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub's API also has bot-looking-UA sensitivities on some paths;
        // matching the User-Agent gotcha this repo already documents for the
        // trigger.dev host itself (AGENTS.md).
        "User-Agent": "datacrew-watchdog-domo-docs-ingest",
      },
    });
    if (!response.ok) {
      logger.warn("could not fetch latest domo-documentation-hub SHA", {
        status: response.status,
      });
      return null;
    }
    const commits = (await response.json()) as Array<{ sha?: string }>;
    return commits[0]?.sha ?? null;
  } catch (error) {
    logger.warn("error fetching latest domo-documentation-hub SHA", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function runDomoDocsIngest(): Promise<IngestOutcome> {
  await safeAddTags(["domo-docs", "ingest", "mdrag"]);
  logger.info("starting domo-docs-ingest", { githubUrl: DOMO_DOCS_GITHUB_URL, mdragApiUrl: MDRAG_API_URL });

  const latestSha = await getLatestUpstreamSha();
  logger.info("domo-docs-ingest upstream check", { latestSha });

  const dcToken = await getSecret("DATACREW_API_TOKEN");

  const response = await fetch(`${MDRAG_API_URL}/api/v1/ingest/git-repo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${dcToken}`,
      // Same WAF gotcha AGENTS.md documents for triggers.datacrew.space
      // itself — a bot-library-looking UA gets a 403 with no mention of
      // auth or tasks. wiki.datacrew.space sits behind the same edge.
      "User-Agent": "datacrew-watchdog-domo-docs-ingest",
    },
    body: JSON.stringify({ github_url: DOMO_DOCS_GITHUB_URL }),
  });

  if (!response.ok) {
    // Never include the request headers/body in the thrown error — the
    // Authorization header carries the bearer token, and this error can
    // land in Trigger.dev's persisted run logs.
    const bodyText = await response.text().catch(() => "");
    logger.error("failed domo-docs-ingest", {
      status: response.status,
      latestSha,
      bodyTail: bodyText.slice(-1000),
    });
    throw new Error(`mdrag ingest/git-repo returned ${response.status}`);
  }

  const job = (await response.json()) as { job_id: string; status: string; status_url: string };

  // "completed" describes THIS task's job (submitting the request) — mdrag's
  // own ingest job is async and still running when this log fires. Named
  // explicitly so a reader doesn't mistake this for "the ingest itself
  // finished" (Copilot review flagged the ambiguity on the plain wording).
  logger.info("completed domo-docs-ingest queue-submission", {
    latestSha,
    jobId: job.job_id,
    jobStatus: job.status,
    statusUrl: job.status_url,
  });

  return {
    status: "queued",
    jobId: job.job_id,
    statusUrl: job.status_url,
    latestSha,
  };
}

export const domoDocsIngest = schedules.task({
  id: "domo-docs-ingest",
  cron: {
    // Matches the bonker cron entry (`domo-docs-ingest-daily`) this replaces.
    pattern: "0 9 * * *",
    environments: ["PRODUCTION"],
  },
  // One SHA fetch + one queueing POST — generous headroom over what either
  // call should ever take, well under the project's 3600s ceiling.
  maxDuration: 300,
  run: async (_payload: DomoDocsIngestPayload) => runDomoDocsIngest(),
});
