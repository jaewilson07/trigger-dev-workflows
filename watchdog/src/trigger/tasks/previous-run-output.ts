import { runs } from "@trigger.dev/sdk";

/**
 * Output of this task's most recent COMPLETED run, or null when it has never
 * completed. The site monitors keep their debounce/dedupe state in their own
 * run outputs: a Trigger.dev container has no durable disk, and a per-5-minute
 * Infisical write would be abuse of the secret store. The API failing throws —
 * a monitor that silently loses its state would re-alert or never alert.
 */
export async function previousRunOutput<T>(taskIdentifier: string): Promise<T | null> {
  const page = await runs.list({ taskIdentifier, status: ["COMPLETED"], limit: 1 });
  const last = page.data[0];
  if (!last) return null;
  const detail = await runs.retrieve(last.id);
  return (detail.output ?? null) as T | null;
}
