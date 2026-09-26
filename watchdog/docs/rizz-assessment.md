# Rizz Assessment Spec (v2)

**Purpose:** Answer "should we keep working on this, or is it dead weight?" for every finding from the nightly repo-hygiene-report scan.

**Phase:** v2 — assessment layer that runs after v1 detection + issue filing.

**Output per finding:** One verdict (KEEP / RESURRECT / KILL) + one-line rationale + confidence score.

**Owner:** EmmaBot (spec), DataCrew (implementation). Status: ready for v2 implementation.

---

## Input: v1 Metadata Fields

| Field | Source | Use in assessment |
|-------|--------|-------------------|
| `last_commit_date` | `git log -1 --format=%ci` | Recency — primary decay signal |
| `commit_count` | `git rev-list --count branch` | Investment signal — high count = more work to lose |
| `branch_merged_status` | `git branch --merged main` or GitHub PR state | Merged = content on main, candidate for KILL |
| `linked_pr` | GitHub API `gh pr list --head branch` | PR existence = intent, review state, or abandonment signal |
| `pr_state` | GitHub API | OPEN = active work or stalled; MERGED = safe to prune; CLOSED = dead |
| `diff_size` | `git diff main...branch --stat` | Large diff = heavy work or massive drift |
| `stash_message` | `git stash list` | Intent clue — "WIP" vs auto-sync-stash |
| `stash_age_days` | `git stash list` date parsing | Old stash with vague message = likely dead |
| `tracked_on_remote` | `git branch -r` | Remote tracking = shared work, not just local experiment |
| `unpushed_commits` | `git log origin/branch..branch` | Unpushed = work not backed up, higher risk if lost |
| `dirty_tree` | `git status --porcelain` | Dirty = in-progress work, don't auto-prune |
| `repo_owner` | GitHub remote URL | Non-jaewilson07 repos go to manual filing section |
| `overlap_with_merged` | `git log --oneline branch --not main` vs merged PRs | If branch commits are subset of merged PRs, safe to KILL |

## Decision Tree

```
START
│
├─ Is this a non-jaewilson07 repo?
│   └─ YES → MANUAL_FILING (Slack digest section, no issue, no verdict)
│
├─ Is the branch the default branch (main/master)?
│   └─ YES → KEEP (never prune default)
│
├─ Is there an active worktree pointing to this branch?
│   └─ YES → KEEP (checked-out = in progress)
│
├─ Is the working tree dirty?
│   └─ YES → KEEP (uncommitted changes = in progress)
│
├─ Is there an OPEN PR linked to this branch?
│   ├─ YES
│   │   ├─ Last commit < 30 days?
│   │   │   └─ YES → KEEP (active PR)
│   │   └─ NO → RESURRECT (stalled PR, worth revisiting or closing)
│   └─ NO → continue
│
├─ Is there a MERGED PR linked to this branch?
│   └─ YES → KILL (content on main, branch is redundant)
│
├─ Is there a CLOSED PR linked to this branch?
│   ├─ Last commit < 14 days?
│   │   └─ YES → RESURRECT (recent closure, may be worth retry)
│   └─ NO → KILL (abandoned work)
│
├─ Is branch marked `--merged main` locally?
│   └─ YES → KILL (merged, no PR needed)
│
├─ Is branch tracked on remote?
│   ├─ YES
│   │   ├─ Unpushed commits?
│   │   │   └─ YES → KEEP (work not backed up)
│   │   └─ NO → continue
│   └─ NO → continue
│
├─ Last commit < 14 days?
│   └─ YES → KEEP (recent work, give it a chance)
│
├─ Last commit 14–60 days?
│   ├─ Commit count > 5?
│   │   └─ YES → RESURRECT (substantial work, stalled)
│   └─ NO → KILL (small experiment, likely dead)
│
├─ Last commit 60–180 days?
│   ├─ Commit count > 10?
│   │   └─ YES → RESURRECT (heavy investment, worth review)
│   └─ NO → KILL (old, low investment)
│
├─ Last commit > 180 days?
│   ├─ Diff size > 500 lines?
│   │   └─ YES → RESURRECT (massive work, maybe worth salvage)
│   └─ NO → KILL (ancient, negligible)
│
└─ Default: KILL (safe default for unknowns)
```

## Verdict Definitions

| Verdict | Meaning | Action |
|---------|---------|--------|
| **KEEP** | Active or recently active — don't touch. | No action. Branch stays. |
| **RESURRECT** | Stalled but valuable — worth revisiting. | File `ready-for-human` issue with reconstructed intent. Include: last commit date, commit count, diff summary, linked PR if any, and a one-line hypothesis of what this was. |
| **KILL** | Dead or redundant — safe to prune. | Add to nightly digest with reply-to-delete command. If Jae confirms, branch is deleted. |
| **MANUAL_FILING** | Non-jaewilson07 repo — can't auto-file. | Goes in Slack digest "needs manual filing" section. No issue, no verdict. |

## Confidence Scores

| Signal | Confidence |
|--------|------------|
| MERGED PR + tip-SHA match | HIGH (auto-prune safe) |
| OPEN PR + recent commit | HIGH (active work) |
| `--merged main` + no remote tracking | HIGH (local merge, safe) |
| Stash with "WIP" message + age < 7 days | MEDIUM (likely in progress) |
| No PR, no remote, commit count = 1, age > 60 days | MEDIUM (small experiment, probably dead) |
| No PR, age 14–60 days, commit count > 5 | MEDIUM (stalled work, needs review) |
| No PR, age > 180 days, diff size > 500 lines | LOW (ambiguous — large but ancient) |
| Auto-sync-stash (message contains "auto-sync") | LOW (often duplicate, but check age) |

## Edge Cases

1. **Post-merge commits**: Branch has MERGED PR but tip-SHA differs from PR head SHA → KEEP (someone committed after merge, potential new work).
2. **Fork-tracking branches**: Branch tracks upstream fork (e.g. `trigger.dev/feat/datacrew-sso`) → KEEP (can't push to upstream, local customization).
3. **Stash duplicates**: Multiple stashes with identical message → KILL all but the newest (dedupe).
4. **Auto-sync-stash**: Message contains "auto-sync" → KILL unless age < 24 hours (backup stashes from sync scripts).
5. **Knowledge-base facade**: Branch in `knowledge-base` repo that's just the symlink facade → skip (not real work).
6. **Worktrees**: Branch with active worktree → KEEP (checked out somewhere).

## Output Format (per finding)

```
## Finding: <repo>/<branch-or-stash>
- **Verdict:** KEEP | RESURRECT | KILL | MANUAL_FILING
- **Confidence:** HIGH | MEDIUM | LOW
- **Rationale:** <one line>
- **Evidence:** last_commit=<date>, commits=<n>, pr=<state|none>, merged=<true|false>, diff=<lines>
```

If RESURRECT, add:

```
- **Hypothesis:** <one-line reconstructed intent>
```

## Integration with v1

- v1 files the issue with metadata.
- v2 (rizz) runs as a second step: reads the issue body, applies this rubric, appends the verdict section.
- If verdict is KILL, the issue body includes a `<!-- reply-to-delete: <branch> -->` marker for the digest command.

## Notes

- This rubric is designed to be embedded as a prompt for a headless Letta agent (`letta -p --agent rizz`).
- Thresholds (14/60/180 days, commit counts) are tuned for Jae's workflow — adjust if patterns shift.
- RESURRECT is the key value-add: reconstructing intent for stalled work. The hypothesis line should be generated from commit messages + branch name + any linked PR title.
- No verdict ever triggers deletion directly. KILL just adds to the digest with a reply-to-delete command. Jae pulls the trigger.
