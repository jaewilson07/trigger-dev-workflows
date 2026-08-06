# Email digest composition rework

**Status:** implemented, deployed (`executive-assistant` 20260805.2), delivery verified live
**Date:** 2026-08-05
**Audit finding:** PARTIAL (R4) — "reuses three research tasks, then POSTs the reply inline"

## The problem

`email-digest` was already the best evidence that the morning-brief split paid off: it
triggers `fetch-emails`, `triage-emails` and `synthesize-brief` — the same three tasks the
cron uses — with `topicResults: []` because a per-user digest tracks no topics. Nothing was
duplicated to make that work.

The delivery half never got the same treatment. `respondEphemeral` was a local `fetch` to
Slack's `response_url` defined inline in the orchestrator and called from three places, and
it had three concrete defects:

1. **No retry**, while `post-slack` retries 3×. The least reliable Slack call in the repo was
   the only one with no protection.
2. **A failed reply threw out of the orchestrator**, discarding a digest that had already
   been fetched, triaged and synthesized — the expensive part.
3. **It could not be composed.** `/email-summary --to-drive` meant editing the orchestrator.

## The change

```
email-digest                        fetch-emails → triage-emails → synthesize-brief
├── deliver-slack-ephemeral         (status replies go straight here)
└── email-digest-deliver            batch.triggerByTaskAndWait, 2 entries
    ├── deliver-slack-ephemeral     the reply
    └── report-gdoc                 opt-in Drive archive, shared with Pattern Hunter
```

## Decisions worth defending

**`response_url` is genuinely a different destination from `post-slack`, and now it says so
in a file.** `post-slack` calls `chat.postMessage` with a bot token against a fixed channel: a
broadcast, addressed by channel id. A `response_url` is unauthenticated (the URL itself is the
capability), scoped to the one interaction that produced it, visible only to the invoking
user, and valid for 30 minutes and 5 uses. The original docstring's reasoning was right —
routing one through the other would mean either posting someone's private inbox summary into
a shared channel, or teaching the generic primitive a second auth model. But "different shape"
argues for a *different destination task*, not for inlining, which is what this rework
implements.

**Retry is now safe and correct.** Slack allows 5 uses of a `response_url`, so a duplicate
ephemeral reply is strictly better than a summary the user never sees. `maxAttempts: 3`,
matching `post-slack`.

**`response_type` is a payload field, not a constant.** The same URL serves both `ephemeral`
(only the invoker sees it — the right default for someone's inbox) and `in_channel`. Making
it explicit keeps a future "share this digest" from needing a second task.

**This does NOT go through `report-deliver`.** `report-deliver` is typed to
`ResearchReport.steps`, the structured multi-step shape Pattern Hunter and Deep Researcher
produce. A digest has no steps; it has a markdown body and an ephemeral URL, and its *primary*
destination is one no other workflow can use. Forcing it through that seam would mean
inventing a fake step list so the wrong renderer could ignore it. `email-digest-deliver`
therefore owns its own two-entry batch — sharing the vocabulary and the fan-out shape, not the
seam.

**The Drive entry reuses `report-gdoc` directly**, wrapping the digest in a minimal
single-step `ResearchReport`. That is honest — a digest genuinely is one step — and it means
Drive delivery has exactly one implementation in this project. The digest markdown is passed
as `markdown` explicitly so `report-gdoc` publishes the digest itself rather than rendering a
report envelope around it.

**Drive is OFF by default**, unlike every other workflow's destinations. A slash command is a
request for an answer in Slack, not a request to create files in someone's Drive; an
on-demand digest silently accumulating a document a day would be a surprise. Opt in per
invocation (`delivery.gdoc.enabled`) or per deploy (`EMAIL_DIGEST_GDOC_ENABLED=true`). That
policy lives in `email-digest-deliver`, not in `report-gdoc`, because it is this workflow's
judgement rather than the destination's.

**Status replies bypass the orchestrator.** `not_connected` and `empty` are short strings with
nothing to archive, so they go straight to `deliver-slack-ephemeral` — and are `.unwrap()`ed
deliberately: if we cannot tell the user their Gmail is disconnected, there is nothing else
the run was going to accomplish. They still get the retry the inline version never had.

**The payload contract with `email_summary.py` is unchanged.** `userId`, `responseUrl` and
`maxResults` keep their meaning; `delivery` is optional. The return type gained a `delivery`
field on the `ok` branch and is otherwise the same three-status union.

## Verification

**`email-digest-deliver`, live** (run `run_cmsfoxmyh00514ilaid3b50h5`):

```
STATUS: COMPLETED  (both destinations in parallel)
├── deliver-slack-ephemeral  COMPLETED  delivered, responseType "ephemeral"
└── report-gdoc              COMPLETED  delivered
    https://docs.google.com/document/d/1OxLT0dFkCExol0Xdih3qgh_Gma3RCTjByu7PcYyvLdU/edit
deliveredCount: 2
```

## Not verified

- **The full `email-digest` chain**, which needs a real `response_url` from a live
  `/email-summary` invocation — those are minted by Slack per interaction and expire in 30
  minutes, so they cannot be fabricated for a test. The research half
  (`fetch-emails` → `triage-emails` → `synthesize-brief`) is unchanged by this rework and is
  exercised daily by `morning-brief`.
- The Slack leg of the verified run posted to a syntactically valid but non-existent
  `hooks.slack.com` path, which Slack answers `200` for. It proves the task ran, was reached
  in parallel with Drive, and reported `delivered`; it does not prove a real ephemeral reply
  renders correctly.
