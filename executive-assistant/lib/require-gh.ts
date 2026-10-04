import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `daily-standup.ts` shells out to `gh` (via the two Python scripts it
 * runs) for branch-protection/issue/PR data. Before 2026-09-26 no project
 * image installed `gh` at all, and both scripts degrade *silently* when
 * it's missing — `which("gh") is None` short-circuits to an empty result
 * (`_run_gh_json` → `[]`, `_branch_protection_status` → `"unknown-no-gh"`)
 * rather than raising. That silent degrade is genuinely dangerous for
 * `audit-branch-protection --enforce` specifically: its enforcement gate
 * (`.agents/runbooks/audit-branch-protection/scripts/main.py`) only fails
 * the run when a repo's status is `"unprotected"` — every repo showing
 * `"unknown-no-gh"` (which is what happens when `gh` is absent) makes
 * `unprotected` an empty list, so `--enforce` exits 0 as if every repo were
 * verified protected. A missing `gh` binary would otherwise produce a
 * standup that *looks* like a clean, successful, fully-enforced run while
 * actually checking nothing.
 *
 * This repo's standing preference is errors that bubble up over silent
 * degradation (see docs/project_notes decisions), so this task calls
 * `assertGhAvailable()` once, up front, before either script runs — instead
 * of leaving the failure mode to whichever script happens to hit it first,
 * three subprocess-layers down where it can't distinguish "this repo really
 * is unprotected" from "the tool that would tell me is missing."
 *
 * `checkGh` is injectable so the decision logic (wrap-and-rethrow with a
 * clear message) is unit-testable without actually shelling out — see
 * `require-gh.test.ts`.
 */
export async function assertGhAvailable(
  checkGh: () => Promise<unknown> = () => execFileAsync("gh", ["--version"])
): Promise<void> {
  try {
    await checkGh();
  } catch (error) {
    throw new Error(
      "gh (GitHub CLI) not found on PATH — required for daily-standup's " +
        "branch-protection/issue/PR audit (both `.agents/runbooks/audit-branch-protection` " +
        "and `alix/.agents/runbooks/run-daily-standup` shell out to it, and silently " +
        "degrade to empty/vacuous results without it). Expected it baked into this image by " +
        "trigger.config.ts's `gitAndUv({ gh: true })` (packages/shared/src/git-uv.ts) — " +
        "check that extension is still configured and the deploy picked it up." +
        (error instanceof Error ? ` Underlying error: ${error.message}` : "")
    );
  }
}
