import { task, logger } from "@trigger.dev/sdk";
import { teachHuntResources, type ResourceEntry } from "./tasks/teach/hunt-resources.js";
import {
  getWorkspaceIndex,
  inferSlug,
  writeMission,
  writeReference,
} from "./lib/learn-vault.js";

/**
 * Keep a teaching workspace's RESOURCES document current, unattended.
 *
 * ## What this is
 *
 * The first unattended phase of `/teach` (Matt Pocock's skill, vendored in the
 * `mattpocock-skills` plugin) rebuilt as a workflow on our own infrastructure,
 * following simpleDiscordBot's `create-workflow` skill. `/teach` is a stateful
 * request — the user learns a topic over many sessions — but every phase of it
 * only runs while someone is typing. Resource hunting does not need a human in
 * the loop, and it is the phase the skill says to do first.
 *
 * ## Where state lives
 *
 * Nothing durable lives in trigger.dev. mdrag's learn vault is the Store: the
 * mission, lessons, references and learning records are all read and written
 * through `lib/learn-vault.ts`, so a run is disposable and the workspace is the
 * record. That is `create-workflow` step 2, and it is the thing that makes this
 * safe to schedule.
 *
 * ## Identity
 *
 * The vault is scoped by the caller's own `dc_` token, so the workspace this
 * writes into belongs to whoever `DATACREW_API_TOKEN` resolves to — emmabot for
 * DataCrew work, which is the default. A personal (alix) workspace is a
 * different token and an explicit decision, never a silent one.
 *
 * ## Requires mdrag#1543
 *
 * The vault's write endpoints ship in that PR. Until it is deployed this task
 * hunts successfully and then 404s on the write — deliberately loud, since a
 * silent no-op would look like a workspace nobody is updating.
 */

export type TeachResourceHuntPayload = {
  /** What is being learned. Used to derive the workspace slug when none is given. */
  topic: string;
  /** Existing workspace slug. Derived from `topic` via the vault when omitted. */
  slug?: string;
  /**
   * Seed mission for a brand-new workspace. Ignored when the workspace already
   * has one — a mission is the user's to write or revise, never a workflow's to
   * overwrite. See the skill: "confirm with the user before changing the mission."
   */
  seedMission?: string;
  /** RESOURCES.md's `## Gaps` — the explicit work queue for this hunt. */
  gaps?: string[];
  maxQueries?: number;
  resultsPerQuery?: number;
};

export type TeachResourceHuntResult = {
  slug: string;
  topic: string;
  refId?: string;
  kept: number;
  rejected: number;
  /** True when this run created the workspace rather than adding to one. */
  bootstrapped: boolean;
};

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );

/**
 * Render RESOURCES as a reference document.
 *
 * Grouped Knowledge / Wisdom because the skill's philosophy splits them:
 * knowledge is captured from high-trust sources, wisdom comes from interacting
 * with other practitioners. A `Gaps` section is carried through verbatim — it is
 * what drives the next hunt, so losing it would break the loop.
 *
 * Styling is inline and deliberately plain: the vault has no shared `assets/`
 * directory yet (mdrag#1545), so there is no stylesheet to link. When that
 * lands, this should link it instead of carrying its own copy.
 */
function renderResourcesHtml(
  topic: string,
  resources: ResourceEntry[],
  gaps: string[],
  generatedAt: string
): string {
  const section = (heading: string, entries: ResourceEntry[]): string => {
    if (entries.length === 0) return "";
    const items = entries
      .map(
        (r) => `      <li>
        <a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a>
        <p>${escapeHtml(r.annotation)}</p>
      </li>`
      )
      .join("\n");
    return `    <h2>${escapeHtml(heading)}</h2>\n    <ul>\n${items}\n    </ul>\n`;
  };

  const gapsSection =
    gaps.length > 0
      ? `    <h2>Gaps</h2>
    <p class="note">What is still missing. This drives the next hunt.</p>
    <ul>\n${gaps.map((g) => `      <li>${escapeHtml(g)}</li>`).join("\n")}\n    </ul>\n`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(topic)} — Resources</title>
  <style>
    body { max-width: 42rem; margin: 3rem auto; padding: 0 1.5rem;
           font: 16px/1.6 Charter, Georgia, serif; color: #1a1a1a; }
    h1 { font-size: 1.6rem; margin-bottom: .25rem; }
    h2 { font-size: 1.1rem; margin-top: 2.5rem; text-transform: uppercase;
         letter-spacing: .08em; color: #555; }
    ul { list-style: none; padding: 0; }
    li { margin: 1.25rem 0; }
    li p { margin: .25rem 0 0; color: #444; font-size: .95rem; }
    a { color: #14507d; }
    .note, .meta { color: #777; font-size: .85rem; }
    @media print { body { margin: 0; max-width: none; } a { color: #000; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(topic)} — Resources</h1>
  <p class="meta">Curated by teach-resource-hunt · ${escapeHtml(generatedAt)}</p>
${section("Knowledge", resources.filter((r) => r.group === "knowledge"))}${section(
    "Wisdom (Communities)",
    resources.filter((r) => r.group === "wisdom")
  )}${gapsSection}</body>
</html>
`;
}

export const teachResourceHunt = task({
  id: "teach-resource-hunt",
  // The hunt child has already spent from the search pool by the time anything
  // here can fail, so a retry would pay that cost twice for the same result.
  retry: { maxAttempts: 1 },
  run: async (payload: TeachResourceHuntPayload): Promise<TeachResourceHuntResult> => {
    logger.info("starting teach-resource-hunt", { topic: payload.topic });

    const slug = payload.slug ?? (await inferSlug(payload.topic));
    const index = await getWorkspaceIndex(slug);
    const bootstrapped = index === null;

    // Seed a mission only for a workspace that has none. An existing mission is
    // the learner's, and the skill is explicit that changing one is a
    // confirmed decision, not a side effect of a scheduled run.
    if (payload.seedMission && !index?.has_mission) {
      await writeMission(slug, payload.seedMission);
      logger.info("seeded mission", { slug });
    }

    const hunt = await teachHuntResources
      .triggerAndWait({
        topic: payload.topic,
        ...(payload.seedMission ? { mission: payload.seedMission } : {}),
        ...(payload.gaps ? { gaps: payload.gaps } : {}),
        ...(payload.maxQueries ? { maxQueries: payload.maxQueries } : {}),
        ...(payload.resultsPerQuery ? { resultsPerQuery: payload.resultsPerQuery } : {}),
      })
      .unwrap();

    if (hunt.resources.length === 0) {
      // Writing an empty RESOURCES over a populated one would destroy curation
      // built up across earlier runs — the reference endpoint is upsert-by-name.
      logger.warn("no resources cleared the trust gate — leaving RESOURCES untouched", {
        slug,
        candidateCount: hunt.candidateCount,
      });
      return {
        slug,
        topic: payload.topic,
        kept: 0,
        rejected: hunt.rejected.length,
        bootstrapped,
      };
    }

    const refId = await writeReference(
      slug,
      "Resources",
      renderResourcesHtml(payload.topic, hunt.resources, payload.gaps ?? [], new Date().toISOString())
    );

    logger.info("completed teach-resource-hunt", {
      slug,
      refId,
      kept: hunt.resources.length,
      rejected: hunt.rejected.length,
      bootstrapped,
    });

    return {
      slug,
      topic: payload.topic,
      refId,
      kept: hunt.resources.length,
      rejected: hunt.rejected.length,
      bootstrapped,
    };
  },
});
