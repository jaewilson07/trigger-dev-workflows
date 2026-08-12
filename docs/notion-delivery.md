# Notion as a delivery destination, everywhere

**Date:** 2026-08-05
**Branch:** `feat/storm-composable-outputs`
**Scope:** a Notion destination for all four end-to-end workflows, across all three
trigger.dev projects.

Companion to `docs/pattern-hunter-rework.md`, `docs/deep-researcher-rework.md`,
`docs/storm-research-rework.md`, `docs/watchdog-rework.md` and
`executive-assistant/docs/morning-brief-rework.md`. Those four documents describe
splitting each workflow into a research half and a delivery half. This one describes
what that split bought: **adding a fifth destination to four workflows cost one
library, three thin tasks, and one line per fan-out.**

---

## 1. What was added

| Project | Library | Destination task | Wired into |
| --- | --- | --- | --- |
| executive-assistant | `lib/notion.ts` | `tasks/deliver-notion.ts` | `brief-deliver` (4th entry), `report-deliver` (4th entry) |
| storm-research | `lib/notion.ts` | `tasks/output-notion.ts` | `storm-deliver` (5th entry) |
| watchdog | `src/lib/notion.ts` | `src/trigger/tasks/infra-deliver-notion.ts` | `infra-health-deliver` (3rd entry) |

Because `report-deliver` is shared, Pattern Hunter and Deep Researcher both gained
Notion without either workflow being touched beyond forwarding an optional
`notion` override — which is the point of the seam those two reworks introduced.

Reach, per workflow:

- **morning-brief** → Slack, Domo, Google Doc, **Notion**
- **pattern-hunter-full-run** → Slack, Google Doc, mdrag, **Notion** (+ the end user's
  own Drive via `pattern-hunter-publish-gdoc`)
- **deep-researcher-full-run** → Slack, Google Doc, mdrag, **Notion**
- **storm-research-full-run** → Slack briefing, Slack .md, Google Doc, mdrag, **Notion**
- **infrastructure-health-report** → Slack, Google Doc, **Notion**

---

## 2. The one real design decision: one task, not two

Every other destination in `executive-assistant` exists twice, once per seam:
`deliver-slack` / `report-slack`, `deliver-gdoc` / `report-gdoc`. That is not
duplication for its own sake — the pairs genuinely differ:

- `deliver-slack` builds Block Kit from `BriefResearch.triageResults`;
  `report-slack` builds it from `ResearchReport.steps`. Neither can read the other's
  payload.
- `deliver-gdoc` defaults to overwriting one rolling document, which is right for a
  daily cron and wrong for research runs where overwriting yesterday's would destroy
  it; `report-gdoc` inverts that default.

Notion has neither problem. Both seams want *"a page in this database, titled X,
containing Y"*, and both already carry a title and rendered markdown. So
`deliver-notion` takes **title and markdown** rather than a seam type, and serves
both halves of the project unchanged. Splitting it would have produced two identical
files differing in an import.

The narrower contract is also what lets the same design be copied verbatim into
storm-research and watchdog, where the seam types are different again
(`StormBriefingWithMarkdown`, `InfraHealthReport`).

### The title is the upsert key

Notion has no natural document id to overwrite, so the title is the key, and that
turns out to encode the "rolling vs per-run" distinction for free — no
`documentId` env var needed:

| Caller | Title | Effect |
| --- | --- | --- |
| `brief-deliver` | `Morning Brief — 2026-08-05` | one row per researched day |
| `report-deliver` | `Pattern Hunter — trailer rental (2026-08-05)` | one row per run |
| `output-notion` | `STORM Research: <topic>` | one row per topic, rewritten on re-research |
| `infra-deliver-notion` | `Infra health — 2026-08-05` | one row per day |

Re-delivering is therefore idempotent by construction: `mode: "replace"` (the
default) clears the page's blocks before rewriting, so a retried or re-triggered
delivery leaves one row with one copy of the content. The date used is always the
**researched** date carried through the seam, not `today`, so a re-delivery of an
older report files itself correctly — the same reasoning `BriefResearch.date` already
documents.

---

## 3. `lib/notion.ts`

Raw `fetch`, not `@notionhq/client`: four endpoints are used (retrieve a database,
query it, create a page, append/delete blocks), and the SDK would be a dependency on
every deploy of every project for a thin wrapper plus types the file already
declares. `googleapis` is vendored in this repo precisely because Drive's API is hard
to speak by hand; Notion's is not.

The `Notion-Version` header is **pinned to `2022-06-28`**, deliberately. Notion's
`2025-09-03` version replaced `parent: { database_id }` with data sources and would
silently change the shape of every call in the file.

### The markdown converter

Ported from `cboti`'s `integrations/notion/markdown_converter.py` — the decisions are
that file's, the implementation is not, because cboti is Python and trigger.dev tasks
are TypeScript in a separate deploy artifact. What carried over is everything that is
a **Notion API constraint** rather than taste, each of which is a 400 on the whole
delivery if ignored:

| Constraint | Handling |
| --- | --- |
| rich-text item ≤ 2000 chars | split, then adjacent same-style runs re-merged |
| ≤ 100 blocks per request | page created with the first 100, rest appended in chunks |
| ≤ 2 levels of nesting per request | deeper list items hoisted to the deepest allowed level, not dropped |
| `code.language` is a closed enum | unknown fence infos → `plain text`, with the usual aliases (`ts`→`typescript`, `jsonc`→`json`) |
| three heading levels | `####`–`######` clamp to `heading_3` |

What did *not* carry over is mistune. This is a line-based parser covering the subset
our renderers actually emit (`lib/render-report.ts`, `lib/format-brief.ts`,
watchdog's `buildMarkdown`): headings, paragraphs, bullet/numbered/task lists with
nesting, fenced code, blockquotes, GFM tables, rules, and inline
bold/italic/strike/code/links. Anything unrecognised survives as paragraph text
rather than being dropped — the one property that matters on a delivery path, since a
report that arrives slightly under-formatted beats a report that does not arrive.

`lib/notion.test.ts` covers this in 18 cases: every block type, the four limits
above, and the leftmost-match rule that makes `**bold**` win over `*italic*` and
`![alt](url)` win over the `[…](…)` nested inside it.

### Two non-obvious API details

**The title property is looked up by type, never assumed.** A database's title
property is named by whoever created it — `Name`, `Title`, `Task name`. Only its
*type* is fixed. Assuming `"Name"` is the single most common way a Notion integration
400s on somebody else's workspace. (The live test below deliberately used a database
whose title property is `Task name`.)

**`extractNotionId` accepts a raw id, a dashed id, or a pasted URL.**
`NOTION_DATABASE_ID` is copied out of a browser far more often than out of an API
response, and a URL-shaped value otherwise fails as an opaque `object_not_found`
rather than as "that isn't an id".

---

## 4. Copied, not imported

`lib/notion.ts` exists three times. That follows the rule
`watchdog/src/lib/infra-delivery.ts` already states: each project has its own
`package.json` and `trigger.config.ts` and deploys as its own artifact, so
cross-project sharing needs a real shared package, not a relative import reaching
outside the project root. `lib/google-docs.ts` is already triplicated on the same
grounds. The copies are trimmed of `NotionDeliveryOutcome` / `notionSkipped`, which
describe executive-assistant's two seams specifically; storm-research and watchdog
have their own vocabularies (`OutputResult`, `InfraDeliveryOutcome`).

The three delivery vocabularies stay deliberately identical in their statuses —
`delivered | skipped | failed`, where **`skipped` is a result and not an error** —
which is the repo-wide convention a future shared package would formalize.

---

## 5. Configuration

`NOTION_TOKEN` and `NOTION_DATABASE_ID`. Either missing → `skipped`, not an error: a
checkout with no Notion integration is a normal state, and reporting it as a failure
trains everyone to ignore the failure count.

**`NOTION_API_KEY` is read as a fallback for `NOTION_TOKEN`.** That is what the secret
is already called in the org's Infisical — one `ntn_` internal-integration secret
owned by a bot named "Triggers.dev" (verified 2026-08-05). Reading both means the
destination works against the existing secret store without renaming a secret other
things may read, and against a plain local `.env` without knowing that history.

`NOTION_API_KEY` was added to `SYNCED_SECRETS` in the executive-assistant and
storm-research `trigger.config.ts`, so a deploy picks it up. **`NOTION_DATABASE_ID`
was not**, and this is load-bearing: that allowlist *throws* on a name it cannot find
in Infisical, so listing a secret that does not exist yet would fail every deploy. Set
the database id on the trigger.dev environment directly, or add it to Infisical and to
`SYNCED_SECRETS` in the same change. Watchdog has no `syncEnvVars` extension at all,
so both values are set on its environment directly.

There is a third unconfigured state worth naming because it fails differently: an
integration that exists but has **never been shared with the target database**. That
is invisible from the environment, so it surfaces as an `object_not_found` and lands
as `failed` with the code in the message. The fix is Notion-side — open the database,
`…` → Connections → add the integration.

---

## 6. Verification

**Static.** All three projects typecheck clean (`tsc --noEmit`). All 36
executive-assistant unit tests pass, including the 18 new converter cases.

**Live, against the real Notion API**, using the org's `NOTION_API_KEY` and the
`Tasks` database (title property `Task name` — chosen because it is *not* `Name`):

| Check | Result |
| --- | --- |
| markdown → blocks | 19 blocks: heading_1/2/3, paragraph, bulleted/numbered/to_do, quote, table, divider, code |
| create | page created, `created: true`, 19 blocks |
| read back | 19 top-level blocks, identical type histogram — real Notion blocks, not escaped text |
| re-upsert same title | same `pageId`, `created: false`, still 19 blocks (no doubling) |
| upsert with title in different case | resolved to the same row; exactly 1 row matched afterwards |
| title-property lookup | resolved `Task name` correctly |
| database id as a pasted URL | accepted |
| `NOTION_API_KEY` only | token resolved |
| both names set | `NOTION_TOKEN` wins |
| neither set | empty → the task reports `skipped` |

Test rows were archived afterwards; the workspace is back to its prior state.

**Not verified: an end-to-end trigger.dev run.** The self-hosted instance has no
personal access token stored, so `trigger.dev deploy` cannot authenticate, and the
`tr_prod_` key only triggers — it cannot deploy. Triggering `deliver-notion` against
the current deployment returns `PENDING_VERSION`, i.e. the task does not exist in the
deployed version yet. What remains untested is therefore the trigger.dev plumbing —
that the batch entries resolve and the fan-out reports four/five destinations — not
the Notion behaviour itself, which is covered above. Deploy each project and re-run
its entry point to close that gap.

---

**2026-08-12 note:** the `storm-research` row in the table above is historical
— that project folded into `executive-assistant` (see
`docs/storm-research-rework.md`'s addendum). `lib/notion.ts` and
`tasks/output-notion.ts` now live under `executive-assistant/`, same as the
`deliver-notion.ts` row; the table isn't rewritten because it accurately
describes what existed on 2026-08-05.
