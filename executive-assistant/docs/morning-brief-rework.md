# Morning brief: research / delivery split

Status: implemented. Supersedes the single-chain `morning-brief.ts`.

## The problem

`morning-brief.ts` was one linear chain:

```
fetch-emails → triage-emails → search-topics → synthesize-brief → post-slack → log-activity
```

Everything in it was welded to everything else. Two consequences:

- **The research wasn't reusable.** A weekly digest, or an on-demand "what's in
  my inbox and what happened with my topics", would have had to re-implement
  the first three steps or trigger the cron task and throw away its Slack post.
- **Delivery was single-destination by construction.** Slack was not a
  destination, it was a step. Adding Domo and a Google Doc meant either three
  more sequential steps in the same chain — where a Domo outage costs you the
  Google Doc that was queued behind it — or a fan-out with nowhere to live.

## The split

Two halves that know nothing about each other, joined by one type.

```
morning-brief (schedule, 07:00 America/Denver)
├── brief-research  ──────────────────────────────► BriefResearch
│     fetch-emails → triage-emails → search-topics
│
├── brief-deliver(research) ─────────────────────► DeliveryReport[]
│     synthesize-brief
│     └── batch.triggerByTaskAndWait  (parallel)
│           ├── deliver-slack       → post-slack
│           ├── deliver-domo-canvas → Domo dataset replace
│           └── deliver-gdoc        → Google Drive
│
└── log-activity
```

`BriefResearch` (`lib/brief-delivery.ts`) is the entire seam:

```ts
{ date, ownerEmail, emailCount, triageResults, topicResults, researched_at }
```

Deliberately **not** the rendered markdown. Slack renders Block Kit and Domo
needs flat rows; a destination handed only a markdown string could do neither.
`date` is stamped once by the research and carried through, so a run that
crosses midnight — or a re-delivery of yesterday's research — still writes the
day it researched.

Each half is independently triggerable. `brief-research` takes `{}` and falls
back to env for owner and topics. `brief-deliver` takes any `BriefResearch`,
from anywhere.

## Design decisions worth knowing

**Synthesize once, deliver three times.** `synthesize-brief` runs in
`brief-deliver`, not per destination. Three destinations each rendering their
own brief is three subtly different briefs.

**`batch.triggerByTaskAndWait`, not `Promise.all`.** Wrapping `triggerAndWait`
in `Promise.all` is unsupported in Trigger.dev. The batch form is the documented
way to run *different* tasks concurrently and wait for all of them, and it
isolates failures: a destination that throws comes back as `runs[i].ok === false`
rather than rejecting the whole call. A Domo outage cannot cost you the Slack
brief.

**The batch is always three entries.** `triggerByTaskAndWait` types its results
positionally, so a conditionally-shortened array loses per-destination types.
Instead every destination is always triggered, and an unconfigured or
caller-disabled one returns `skipped`. Side benefit: the run history shows, per
morning, exactly which destinations were live and why the others were not.

**`skipped` is a result, not an error.** An unconfigured destination is the
normal state of a fresh checkout — the same "a well-formed refusal is not a
crash" convention `tasks/pattern-hunter-publish-gdoc.ts` already documents. Only
a genuine failure throws, where Trigger.dev's retry applies.

**A failed destination does not fail `brief-deliver`.** The others already
delivered; throwing would retry them too. Failures are logged at `error` and
counted in `failedCount`. `morning-brief` warns separately if *nothing* landed.

## Destinations

### Slack — unchanged behaviour

`deliver-slack` is a thin adapter over the existing `post-slack`, which stays
the generic Slack primitive (channel/text/blocks, chunking, error detail). Same
blocks, same markdown fallback, same call as before the split. The one new thing:
the brief's date now comes from the research rather than from `new Date()` at
post time.

Config: `MORNING_BRIEF_SLACK_CHANNEL`.

### Domo — dataset replace

**Domo has no canvas API.** There is no endpoint that writes prose onto a
dashboard the way Slack's canvas API does. A Domo card is bound to a **dataset**
and re-renders when that dataset changes. So "update the Domo canvas" is,
concretely, "replace the rows of the dataset the card reads". The card is built
once by hand; the task only ever feeds it.

`lib/domo-dataset.ts` is a route-for-route TypeScript port of crew-dcs's
`routes/dataset/upload.py`, against Domo's **internal** `/api/data/v3`
endpoints (not the public `api.domo.com` Data API — different shape entirely):

1. `POST /api/data/v3/datasources/{id}/uploads` → `uploadId`
2. `PUT  …/uploads/{uploadId}/parts/1` — headerless CSV, `text/csv`
3. *(5s pause — crew-dcs does the same; the parts endpoint returns before Domo
   has durably staged them, and committing too early drops rows)*
4. `PUT  …/uploads/{uploadId}/commit` — `{ index: false, action: "REPLACE" }`
5. `POST …/indexes` — `{ dataIds: [] }`, what actually makes rows visible to cards

Ported rather than called because crew-dcs is Python and there is no interpreter
in the deployed task image — the same constraint
`tasks/pattern-hunter-publish-gdoc.ts` documents for its own case. Auth is an
admin-panel access token sent as `x-domo-developer-token`
(crew-dcs `DomoTokenAuth`).

REPLACE, not APPEND: the brief is a snapshot, and the card should show today's
brief rather than every brief ever run. Retries are therefore safe.

**One-time setup.** Stage 2 uploads headerless CSV, which Domo maps by
**position** against the dataset's existing schema. The dataset must already
exist with exactly the columns in `lib/brief-rows.ts`, in order:

| column       | Domo type | notes                                            |
| ------------ | --------- | ------------------------------------------------ |
| `brief_date` | DATE      | the researched day, `YYYY-MM-DD`                 |
| `section`    | STRING    | `summary` \| `inbox` \| `topic`                  |
| `rank`       | LONG      | 1-based within section; `0` for the summary row  |
| `category`   | STRING    | triage category, or the tracked topic            |
| `title`      | STRING    | email subject, or result title                   |
| `subtitle`   | STRING    | sender, or result source                         |
| `detail`     | STRING    | one-line summary or snippet, capped at 1000 chars|
| `url`        | STRING    | topic results only                               |
| `action`     | STRING    | proposed triage action                           |
| `confidence` | DOUBLE    | `0.00` is gateway-llm's degraded-verdict signal  |

Create it by uploading one CSV by hand (Domo → Data → CSV) — `briefCsvWithHeader`
in `lib/brief-rows.ts` emits exactly that file, header included — then point
`MORNING_BRIEF_DOMO_DATASET_ID` at the result and build the card against it.
Reordering the schema afterwards silently shifts every value one column, which
is why the column list is a published contract and has a test pinning it.

One wide table rather than three, so a single card filters on `section` instead
of the dashboard needing three datasets kept in sync.

Config: `DOMO_INSTANCE`, `DOMO_ACCESS_TOKEN`, `MORNING_BRIEF_DOMO_DATASET_ID`,
optional `MORNING_BRIEF_DOMO_CARD_URL`.

### Google Doc — direct, not via Pattern Hunter

`deliver-gdoc` writes through `lib/google-docs.ts` → `lib/google-auth.ts`, the
same fresh-token path `fetch-emails` uses.

**Why not reuse `pattern-hunter-publish-gdoc.ts`.** That task is right for its
own job — a browser-triggered "save *this* report to *my* Drive", where Pattern
Hunter owns the consent dance and every call creates a new doc. The morning brief
is a scheduled job for one known owner that wants an **update**: a stable doc id
and URL that today's brief overwrites, so a bookmark keeps working. Pattern
Hunter's `POST /publish/gdoc` has no update path, and routing a cron through a
consent-required 409 means a brief that silently stops publishing the day
consent lapses.

**Markdown conversion is Drive's, not ours.** Drive imports `text/markdown` into
a native Google Doc — headings, bold, lists and links survive — so
`lib/format-brief.ts`'s existing output goes up untouched. No second markdown
renderer to keep in step with the Slack one.

Two modes:

- `MORNING_BRIEF_GDOC_DOCUMENT_ID` set → that doc is overwritten in place.
  Recommended for a daily cron.
- unset → a new dated doc per run, in `MORNING_BRIEF_GDOC_FOLDER_ID` if given.
  An archive, at the cost of a new URL each morning.

**Scope caveat.** The stored token must carry Drive write scope
(`.../auth/drive.file` covers docs this OAuth client created; overwriting a doc
created by a *different* client needs the broader `.../auth/drive`). cboti's
`ALL_SCOPES` includes both, but a token granted for Gmail alone will 403 here —
deliberately loud, since a brief that silently stops reaching Drive is worse
than one that reports why.

Config: `MORNING_BRIEF_GDOC_DOCUMENT_ID`, `MORNING_BRIEF_GDOC_FOLDER_ID`, and
the existing `MORNING_BRIEF_GOOGLE_OWNER_EMAIL` (via the research payload).

## Files

New:

| file                             | what                                             |
| -------------------------------- | ------------------------------------------------ |
| `brief-research.ts`              | research workflow → `BriefResearch`              |
| `brief-deliver.ts`               | synthesize + parallel fan-out                    |
| `tasks/deliver-slack.ts`         | Slack destination (adapter over `post-slack`)    |
| `tasks/deliver-domo-canvas.ts`   | Domo destination                                 |
| `tasks/deliver-gdoc.ts`          | Google Doc destination                           |
| `lib/brief-delivery.ts`          | `BriefResearch`, `DeliveryOutcome`, helpers      |
| `lib/brief-rows.ts`              | `BriefResearch` → Domo rows (the column contract)|
| `lib/domo-dataset.ts`            | Domo 3-stage upload, ported from crew-dcs        |
| `lib/google-docs.ts`             | markdown → Google Doc create/update              |
| `lib/brief-rows.test.ts`         | pins the column contract and CSV quoting         |

Changed: `morning-brief.ts` (now just the schedule), `.env.example`,
`package.json` (test script).

Unchanged: `fetch-emails`, `triage-emails`, `search-topics`, `synthesize-brief`,
`post-slack`, `log-activity`, `lib/format-brief.ts`, `lib/slack-blocks.ts`.

## Identity, still

The three identities note at the top of `morning-brief.ts` still applies and
still matters. The Google owner email is now read by `brief-research.ts`, which
is what needs it; the note stays in `morning-brief.ts` because that is where the
chain starts and where the mix-up keeps wanting to happen.

`deliver-gdoc` defaults its `ownerEmail` to `research.ownerEmail` — the same
Google identity that fetched the mail — rather than reading an env var of its
own, so there is one fewer place to put the wrong one of the three.

## Not done

- **`brief-research` runs its three steps sequentially.** Email fetch/triage and
  topic search are independent and could be parallel. Left sequential — as it
  was before the split — because triage can take a slow Letta fallback path and
  keeping the order makes one failure attributable to one step. The chain is
  minutes long against a 07:00 cron either way.
- **No Domo card is created by code.** The dashboard is built once by hand
  against the schema above.
- **The Domo and Drive paths have not been run against live credentials** —
  neither `DOMO_*` nor a Drive-scoped token is configured in this environment
  yet. The wire protocol is ported route-for-route from crew-dcs rather than
  guessed, and the Drive call is stock `googleapis`, but first live runs should
  be watched.

---

## Since: Notion (2026-08-05)

A Notion destination was added to every workflow in the repo — see
`docs/notion-delivery.md`. `brief-deliver`'s batch went from three entries to four, plus one new
`tasks/deliver-notion.ts` — which, unusually, serves BOTH this seam and
`report-deliver`'s, because Notion needs only a title and markdown where Slack
and Drive needed the structure.

The point worth recording here is the cost: adding a destination that reaches four
workflows took one library, three thin tasks, and one entry per fan-out, with no
research code touched. That is what the split in this document was for.
