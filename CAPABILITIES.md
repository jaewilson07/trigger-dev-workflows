# Capabilities

What a person can do with the workflows in this repo, whether it is true today,
and what proves it.

**This file is an index. It holds no stories.** One line per capability, gist
plus link; the stories and their evidence live in `docs/capabilities/<name>.md`.
A story lives in exactly one place, so the index can never contradict it.

**What this repo is for**, per Jae's standing principle (recorded on
[mdrag#1141](https://github.com/jaewilson07/mdrag/issues/1141), formalized
workspace-wide as
[ADR-054](https://github.com/jaewilson07/simpleDiscordBot/blob/main/.agents/adrs/ADR-054-trigger-dev-is-the-orchestration-layer-not-github-actions.md)):
trigger.dev is for **non-interactive** workflows — the n8n / make.com role.
Interactive thinking-partner conversations belong on the wiki. Where a workflow
runs matters less than the invariant that **every one of them reaches
knowledge only through mdrag's search, storage and retrieval tooling.**
ADR-054 makes this binding, not just a norm: any repeatable, scheduled task
lands here as a Trigger.dev task, in any repo in this workspace, not as a
GitHub Actions `schedule:` workflow.

| Capability | Gist | Status |
|---|---|---|
| [STORM research](docs/capabilities/storm-research.md) | A topic in, a cited and fact-checked report out, built from several expert lenses arguing with each other. | The pipeline is solid and resumable. Writes back through mdrag; **retrieves with its own `web_search`**, which is the one unmet substrate invariant. |
| Morning brief | A daily digest assembled and delivered to Slack. | Not yet harvested. |
| Deep researcher | Recursive multi-level research. | Not yet harvested. |
| Email digest | Inbox summarised and delivered. | Not yet harvested. |
| Watchdog | Scheduled infrastructure checks. | Not yet harvested. |
| Pattern Hunter interview | The interview half of Pattern Hunter, which runs here rather than in the wiki. | Not harvested here — it belongs to the Pattern Hunter capability in `libraries/mdrag/docs/capabilities/pattern-hunter.md`, and whether it should run here at all is [mdrag#1143](https://github.com/jaewilson07/mdrag/issues/1143). |

Harvest began 2026-08-25 under
[mdrag#1142](https://github.com/jaewilson07/mdrag/issues/1142). Total coverage
was not attempted — STORM came first because it is one of the four interaction
modes the wiki wayfinder map is about. Rows marked *not yet harvested* have
stories in issues; they just have not been pulled into a doc yet.

---

## Writing one

The contract, the template and the rules are maintained once, in
[`libraries/mdrag/CAPABILITIES.md`](https://github.com/jaewilson07/mdrag/blob/main/CAPABILITIES.md#writing-one).
Read it there rather than keeping a second copy that drifts.

The short version:

- **A capability is something a user would name, and that can be true or false.**
  `docs/capabilities/*.md` is globbed **flat** by the second-brain sync
  (`.agents/skills/sync-docs-to-kb/doc_targets.py`, `STEERING_GLOBS`), so a
  nested file is deliberately not indexed.
- **Evidence is the whole point** — every story carries a `file:line`, an
  endpoint, or the issue that would build it.
- **Harvest; do not decide.** Record contradictions rather than resolving them.
- **A PRD cites the capability it serves**; it does not parent its own stories.

Note the cross-repo case this repo runs into first: a capability whose halves
live in two repos (Pattern Hunter's interview here, its report in mdrag) is
**one** capability documented in the repo that owns the user-facing whole, with
the other repo's index pointing at it. Duplicating it in both is how the two
copies start disagreeing.

## Related

- `AGENTS.md` — how to work in this repo.
- `libraries/mdrag/CAPABILITIES.md` — the knowledge substrate every workflow
  here depends on.
- Deploys are bonker-only; see `.agents/skills/deploy-trigger-tasks`.
