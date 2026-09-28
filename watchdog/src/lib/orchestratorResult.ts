/**
 * Shared stdout/stderr contract for `domoCommunityJournal.ts` and
 * `slackCommunityJournal.ts` — both clone-and-invoke `jaewilson07/datacrew`'s
 * `main.py` via `runUv()` (`packages/shared/src/git-uv.ts`) and need to (a)
 * parse the child's final JSON result off stdout and (b) surface a useful
 * error when the child exits non-zero.
 *
 * **Bug #1 this fixes (stdout):** both tasks used to do
 * `JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}")`. `main.py`'s
 * last line is `print(json.dumps(result, indent=2))` — pretty-printed, so its
 * OWN last line is a lone `}`, not a JSON document. `.split("\n").pop()` grabs
 * that lone `}` and `JSON.parse` throws `Unexpected token '}'`
 * (slack-community-journal run `run_cmul9a4fg01cc4hl839sntvu8`, confirmed live
 * by reproducing `main.py --dry-run` locally: stdout is *only* that
 * pretty-printed JSON block — Python's `logging.basicConfig()` default handler
 * writes to stderr, so nothing else shares stdout with it). The fix is to
 * parse the whole trimmed stdout as one JSON document, not its last line.
 * `domoCommunityJournal.ts` has the identical `.split("\n").pop()` call; its
 * failing run never reached it (it died earlier, at the letta-gateway 502 —
 * see `describeOrchestratorFailure` below), but the same fix applies there so
 * this doesn't resurface the next time the child's stdout call succeeds.
 *
 * **Bug #2 this fixes (stderr):** `runUv()`'s rejected `Error.message` is
 * `execFile`'s own `Command failed: <argv>\n<full stderr, chronological>`.
 * `main.py` logs `INFO` lines (HTTP request/response traces) to stderr before
 * any traceback, so a real failure's message is front-loaded with those INFO
 * lines and the actual `Traceback`/exception is at the very end. Trigger.dev's
 * own error persistence truncates from the head (keeps the first ~1-2KB,
 * appends "...[truncated]"), which is exactly backwards for this shape of
 * error — the domo-community-journal run (`run_cmul9a45201ca4hl8gp2ouflc`)
 * only ever showed 5 lines of Domo forum `HTTP/1.1 200 OK` INFO logs before
 * being cut off; the actual failure (`llm_client.LlmError: letta gateway call
 * failed: Server error '502 Bad Gateway' for url
 * 'http://letta-shim:8400/v1/chat/completions'`) was recovered only by
 * querying ClickHouse's `task_runs_v2.error` directly. The fix: put the LAST
 * non-empty stderr line (almost always the actual exception's message) FIRST
 * in the thrown error's message, followed by a bounded stderr tail, so even a
 * second round of head-first truncation (Trigger.dev's) can't cut off the one
 * line that actually says what broke.
 */

const STDERR_TAIL_CHARS = 4000;

export type OrchestratorResult = {
  status?: string;
  item_count?: number;
  [key: string]: unknown;
};

/**
 * Parses an orchestrator child's stdout as a single JSON document (its final
 * `print(json.dumps(result, indent=2))`). Empty/whitespace-only stdout
 * returns `fallback` rather than throwing — that shouldn't happen for a
 * successful run, but it's a safer default than crashing on it.
 */
export function parseOrchestratorResult(
  stdout: string,
  fallback: OrchestratorResult = {}
): OrchestratorResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    return JSON.parse(trimmed) as OrchestratorResult;
  } catch (cause) {
    const snippet =
      trimmed.length > 500 ? `${trimmed.slice(0, 250)}...(truncated)...${trimmed.slice(-250)}` : trimmed;
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `orchestrator stdout was not valid JSON (expected exactly one JSON document, ` +
        `main.py's final print(json.dumps(result, indent=2))): ${causeMessage}\n` +
        `stdout was:\n${snippet}`
    );
  }
}

/**
 * Builds a diagnosable failure message for an orchestrator child's non-zero
 * exit, leading with the last non-empty stderr line (almost always the real
 * exception) before a bounded stderr tail — see this module's docstring for
 * why order matters here.
 */
export function describeOrchestratorFailure(label: string, error: unknown): string {
  const err = error as (Error & { stderr?: string; stdout?: string }) | null | undefined;
  const message = err instanceof Error ? err.message : String(error);
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";

  if (!stderr) {
    return `${label} failed: ${message}`;
  }

  const lines = stderr.split("\n").filter((line) => line.trim().length > 0);
  const finalLine = lines[lines.length - 1] ?? "";
  const tail = stderr.length > STDERR_TAIL_CHARS ? stderr.slice(-STDERR_TAIL_CHARS) : stderr;

  return `${label} failed: ${finalLine}\n\nstderr tail (last ${tail.length} chars):\n${tail}`;
}
