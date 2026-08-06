import { task, logger } from "@trigger.dev/sdk";
import { postPatternHunter, PatternHunterError } from "../lib/pattern-hunter-client.js";

/**
 * "Save to Google Docs" (datacrew#338) — the ONE Trigger.dev task the
 * frontend triggers directly from the BROWSER (via `mintMultiUseTriggerToken`
 * in `../../frontend/src/lib/trigger-server.ts` + `@trigger.dev/react-hooks`'
 * `useRealtimeTaskTrigger`, same shape `WorkflowRunner.tsx` already uses to
 * trigger `pattern-hunter-full-run`), rather than being chained from another
 * task the way `pattern-hunter-brief.ts` etc. are.
 *
 * WHY THIS GOES THROUGH TRIGGER.DEV AT ALL, not a direct browser/Next.js-
 * server call to Pattern Hunter: every OTHER integration point with Pattern
 * Hunter's FastAPI service in this repo is a Trigger.dev task calling
 * `postPatternHunter` (`pattern-hunter-full-run.ts` and every
 * `tasks/pattern-hunter-*.ts` file) — the frontend's own
 * `.env.example` says explicitly "Pattern Hunter's own FastAPI service is
 * NOT called from this frontend at all." That's because only the Trigger.dev
 * task-runner deployment is known to be network-reachable to Pattern
 * Hunter's internal-only container (`PATTERN_HUNTER_URL=http://pattern-hunter:8090`
 * on `ai-network` — see `projects/pattern-hunter/AGENTS.md`'s "Deployment"
 * section: "No public/Caddy route exists ... this service has no auth, so
 * it must stay internal-only"). This task follows that SAME established
 * path rather than opening a new, unverified network route from the
 * frontend's own server straight to Pattern Hunter.
 *
 * NOT `lib/python.ts` — this is a plain HTTP call from Node to Pattern
 * Hunter's FastAPI service (`postPatternHunter`), the exact same mechanism
 * `pattern-hunter-brief.ts`/`-hypotheses.ts`/etc. already use in production.
 * It shells out to nothing and needs no Python interpreter in the deployed
 * task image — see datacrew#338's own explicit instruction not to route
 * this through the Python bridge.
 *
 * MULTIPLE-USE, NOT ONE-SHOT: `WorkflowRunner.tsx`'s trigger token is
 * deliberately one-time-use (see `mintTriggerToken`'s doc comment in
 * `trigger-server.ts`) because a workflow run is triggered exactly once.
 * Saving to Drive is different: the frontend's `SaveToDriveButton` may need
 * to call THIS task several times with the identical payload — once, get
 * back `consent_required`, send the user to Google's consent screen in a
 * new tab, then re-trigger this same task on a short poll until it either
 * succeeds or the user gives up — so it's minted via
 * `mintMultiUseTriggerToken` instead. See that function's own doc comment
 * for why this is a legitimate, narrow use of `{ multipleUse: true }`,
 * distinct from the self-hosted one-time-use-token BUG `mintTriggerToken`
 * documents (this is a genuine functional need for repeat triggers, not a
 * workaround for that bug).
 *
 * RESULT SHAPE: a well-formed "not yet, here's what to do" (consent
 * required) is a returned RESULT, never a thrown error — same "well-formed
 * refusal is not a crash" convention `main.py`'s own routes already follow
 * (e.g. `/brief`'s `answer_found: false`). Only a genuine call failure
 * (Pattern Hunter unreachable, a real 5xx, a malformed 409 body) throws and
 * lets Trigger.dev's own `retry` apply.
 */
export type PatternHunterPublishGDocPayload = {
  /** Opaque signed-in-user identity (e.g. an email) — see
   * `main.py`'s `PublishGDocRequest.user_id` docstring for the auth
   * service's own "shared key prefix" wart this passes straight through
   * to. */
  user_id: string;
  title: string;
  markdown_content: string;
};

export type PublishGDocResult =
  | { status: "completed"; doc_id: string; doc_url: string }
  | { status: "consent_required"; consent_url: string };

/** Pattern Hunter's own `PublishGDocResponse` (`main.py`) — mirrored, not
 * guessed, matching this file group's existing convention of typing each
 * task's expected wire response against the real Python model. */
type PublishGDocResponse = {
  status: string;
  doc_id: string;
  doc_url: string;
};

/** Pattern Hunter's `POST /publish/gdoc` 409 body shape
 * (`{"detail": {"error": "consent_required", "consent_url": "..."}}` — see
 * `main.py`'s `publish_gdoc` route). Extracted defensively: a 409 that
 * DOESN'T parse into this shape is NOT silently treated as consent_required
 * — it's rethrown as a genuine failure (this repo's no-silent-failures
 * convention: guessing at a malformed error body's meaning is exactly the
 * kind of silent behavior that convention forbids). */
function extractConsentUrl(responseBody: string): string | undefined {
  try {
    const parsed = JSON.parse(responseBody) as {
      detail?: { error?: string; consent_url?: string };
    };
    if (parsed.detail?.error === "consent_required" && parsed.detail.consent_url) {
      return parsed.detail.consent_url;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const PATTERN_HUNTER_PUBLISH_API_KEY = process.env.PATTERN_HUNTER_PUBLISH_API_KEY ?? "";

export const patternHunterPublishGDoc = task({
  id: "pattern-hunter-publish-gdoc",
  // maxAttempts: 2, same as every other Pattern Hunter node task — covers a
  // transient Pattern Hunter/auth-service 502. consent_required (409) is
  // handled BELOW as a returned result, not a thrown error, so it never
  // triggers this retry — retrying an expected "not consented yet" outcome
  // would just waste attempts.
  retry: { maxAttempts: 2 },
  run: async (payload: PatternHunterPublishGDocPayload): Promise<PublishGDocResult> => {
    logger.info("starting pattern-hunter-publish-gdoc");
    if (!PATTERN_HUNTER_PUBLISH_API_KEY) {
      // Fails loud rather than sending an unauthenticated request Pattern
      // Hunter would 403 anyway — same "check before the call, not just
      // after" posture main.py's own routes use for their required env vars.
      throw new Error(
        "PATTERN_HUNTER_PUBLISH_API_KEY is not set in the Trigger.dev task's " +
          "own environment — required to call Pattern Hunter's POST /publish/gdoc"
      );
    }

    try {
      const response = await postPatternHunter<PublishGDocResponse>(
        "publish/gdoc",
        {
          user_id: payload.user_id,
          title: payload.title,
          markdown_content: payload.markdown_content,
        },
        { "X-Publish-API-Key": PATTERN_HUNTER_PUBLISH_API_KEY }
      );
      return { status: "completed", doc_id: response.doc_id, doc_url: response.doc_url };
    } catch (err) {
      if (err instanceof PatternHunterError && err.status === 409) {
        const consentUrl = extractConsentUrl(err.responseBody);
        if (consentUrl) {
          return { status: "consent_required", consent_url: consentUrl };
        }
        // A 409 that doesn't match the documented consent_required shape —
        // genuinely unexpected, so it falls through and rethrows below
        // rather than silently guessing this was a consent prompt.
      }
      throw err;
    }
  
    logger.info("completed pattern-hunter-publish-gdoc");
  },
});
