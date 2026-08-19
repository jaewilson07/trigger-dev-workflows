/**
 * Seam + delivery vocabulary for the Blues Drop of the Week
 * (trigger-dev-workflows#98).
 *
 * `delivered | skipped | failed` matches
 * `watchdog/src/lib/infra-delivery.ts` and
 * `executive-assistant/lib/brief-delivery.ts` deliberately: `skipped` is a
 * RESULT, not an error — a week already posted this run is a normal state,
 * not a failure to report. Copied here rather than imported, per
 * `docs/ADR-002-research-seam-delivery-composition.md` §4: `indb-blues` has
 * its own `package.json`/`trigger.config.ts` and deploys independently, so
 * cross-project sharing of this vocabulary would need a real shared
 * package, same as watchdog and executive-assistant's copies.
 */

export type BluesDropTrack = {
  artist: string;
  album: string;
  categories: string[];
  spotify_url: string | null;
  spotify_id: string | null;
  matched: boolean;
};

/**
 * The research → delivery seam. Structured, not rendered — `deliver-discord`
 * builds the markdown post itself, so a future destination needing a
 * different shape (Notion, per trigger-dev-workflows#99) is a new task, not
 * an edit to this type or to `deliver-discord`.
 */
export type BluesDropResearch = {
  weekId: string;
  mode: "artist-spotlight";
  topic: string;
  sourceUrl: string;
  contextParagraph: string;
  /** True when this week's id was already present in drop_manifest.json at
   * research time — informational only; `deliver-discord` re-checks the
   * manifest itself against a fresh clone before posting, since research and
   * delivery run as separate trigger.dev invocations against separate
   * ephemeral clones. */
  alreadySynced: boolean;
  tracks: BluesDropTrack[];
  generatedAt: string;
};

/** trigger-dev-workflows#99 adds "notion" as a second, always-triggered
 * entry in `blues-drop-deliver`'s batch — see that task's own doc comment
 * for why the batch was already shaped to make this an array entry, not a
 * restructure. */
export type BluesDropDestination = "discord" | "notion";

export type BluesDropDeliveryOutcome =
  | {
      destination: "discord";
      status: "delivered";
      weekId: string;
      discordUrl: string;
      threadId: string;
      title: string;
    }
  | {
      destination: "notion";
      status: "delivered";
      weekId: string;
      url: string;
      pageId: string;
      created: boolean;
      title: string;
    }
  | { destination: BluesDropDestination; status: "skipped"; weekId: string; reason: string };

export type BluesDropDeliveryReport =
  | BluesDropDeliveryOutcome
  | { destination: BluesDropDestination; status: "failed"; weekId: string; error: string };

export function bluesDropSkipped(
  destination: BluesDropDestination,
  weekId: string,
  reason: string
): BluesDropDeliveryOutcome {
  return { destination, status: "skipped", weekId, reason };
}
