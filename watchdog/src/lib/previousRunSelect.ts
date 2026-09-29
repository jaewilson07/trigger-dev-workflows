/**
 * Validates the first row of a `/api/v1/runs` list before its output is trusted
 * as this task's saved state. If the API ignores a filter it does not
 * recognise, it answers 200 with some OTHER task's newest run, and reading that
 * run's output would silently corrupt the debounce/dedupe state.
 */
export class PreviousRunMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviousRunMismatchError";
  }
}

export type ListedRun = { id?: string; taskIdentifier?: string; status?: string };

/** Returns the run id to read, or null when the list is empty. */
export function selectPreviousRunId(list: { data?: ListedRun[] }, taskIdentifier: string): string | null {
  const first = list.data?.[0];
  if (!first) return null;
  if (first.taskIdentifier !== taskIdentifier || first.status !== "COMPLETED" || !first.id) {
    throw new PreviousRunMismatchError(
      `runs list returned ${first.id ?? "(no id)"} with taskIdentifier=${first.taskIdentifier} status=${first.status}, ` +
        `expected ${taskIdentifier}/COMPLETED: the list filters were probably ignored`,
    );
  }
  return first.id;
}
