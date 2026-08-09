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
 * `x-user-email: jae@datacrew.space` is sent explicitly (mirroring the bash
 * script) so the ingested repo lands in the same collection ownership the
 * manual/cron path always used — `_resolve_owner_email` reads this header
 * directly, it is not derived from the JWT's own `email` claim.
 */

const DOMO_DOCS_OWNER = "DomoApps";
const DOMO_DOCS_REPO = "domo-documentation-hub";
const DOMO_DOCS_GITHUB_URL = `https://github.com/${DOMO_DOCS_OWNER}/${DOMO_DOCS_REPO}/tree/main/s/article`;
const DOMO_DOCS_LATEST_COMMIT_URL = `https://api.github.com/repos/${DOMO_DOCS_OWNER}/${DOMO_DOCS_REPO}/commits?per_page=1`;

// Overridable so a dev/preview run can point at a non-prod mdrag without a
// code change. Defaults to the same canonical unified-gateway hostname
// `calling-mdrag-from-agents.md` documents for every off-host caller.
const MDRAG_API_URL = process.env.MDRAG_API_URL ?? "https://wiki.datacrew.space";
const MDRAG_OWNER_EMAIL = "jae@datacrew.space";

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
      "x-user-email": MDRAG_OWNER_EMAIL,
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

  logger.info("completed domo-docs-ingest", {
    latestSha,
    jobId: job.job_id,
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
