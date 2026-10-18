import { task, logger } from "@trigger.dev/sdk";
import { learnHuntResources, type ResourceEntry } from "./tasks/learn/hunt-resources.js";
import {
  getWorkspaceIndex,
  inferSlug,
  writeMission,
  writeReference,
} from "./lib/learn-vault.js";
import {
  writeMissionAnnotation,
  writeResourceAnnotation,
} from "./lib/learn-annotations.js";
import { resolveOrCreateConversation } from "./lib/mdrag-conversation-resolver.js";

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

export type LearnResourceHuntPayload = {
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
  /**
   * Whose learn session this is. Determines the Conversation, and therefore
   * the Collection every annotation lands in. Falls back to the token's own
   * identity when omitted, which is right for a personal scheduled run and
   * wrong for anything acting on someone else's behalf.
   */
  userEmail?: string;
};

export type LearnResourceHuntResult = {
  slug: string;
  topic: string;
  refId?: string;
  kept: number;
  rejected: number;
  /** True when this run created the workspace rather than adding to one. */
  bootstrapped: boolean;
  /** The learn Conversation this run is bound to — the same one on every rerun. */
  conversationId: string;
  /** Where the annotations landed. */
  collectionId?: string;
  /** Resource annotations written (kept + rejected). Distinct from `kept`. */
  annotationsWritten: number;
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
  <p class="meta">Curated by learn-resource-hunt · ${escapeHtml(generatedAt)}</p>
${section("Knowledge", resources.filter((r) => r.group === "knowledge"))}${section(
    "Wisdom (Communities)",
    resources.filter((r) => r.group === "wisdom")
  )}${gapsSection}</body>
</html>
`;
}

/**
 * Write one `learn_resource` annotation per resource the hunt judged.
 *
 * Rejections are recorded alongside the keeps, deliberately. A record of what
 * was considered and refused is what stops the next hunt re-fetching,
 * re-critiquing and re-rejecting the same page — the cost this workflow is
 * most exposed to, since live hunts exhaust the search pool after a handful of
 * runs.
 *
 * ## Why a failure here doesn't fail the run
 *
 * By the time this is reached the vault write has already landed, so the
 * learner's RESOURCES page is current either way. Throwing would mark a run
 * failed whose user-visible work succeeded, and `retry: { maxAttempts: 1 }`
 * means there is no second attempt to recover on — it would just lose the
 * result. So each annotation is attempted independently and failures are
 * logged and counted: the run reports how many records it actually wrote,
 * and `annotationsWritten < kept + rejected` is the signal that something is
 * wrong, rather than a silent success.
 *
 * A missing `collectionId` is the one case that skips the whole step: with no
 * Collection resolved there is nowhere correct to put a record, and inventing
 * a destination is worse than not writing one.
 */
async function recordResourceVerdicts(
  slug: string,
  collectionId: string | undefined,
  kept: ResourceEntry[],
  rejected: { url: string; reason: string }[]
): Promise<number> {
  if (!collectionId) {
    logger.warn("no collection resolved — skipping resource annotations", {
      slug,
      kept: kept.length,
      rejected: rejected.length,
    });
    return 0;
  }

  let written = 0;
  for (const r of kept) {
    try {
      await writeResourceAnnotation(slug, {
        payload: {
          url: r.url,
          title: r.title,
          verdict: "trusted",
          rationale: r.rationale,
          resource_class: r.group,
          covers: r.annotation ? [r.annotation] : [],
        },
        collectionId,
        annotatorVersion: "learn-hunt-resources@critique-gate",
      });
      written += 1;
    } catch (err) {
      logger.error("failed to record a kept resource", { slug, url: r.url, err: String(err) });
    }
  }

  for (const r of rejected) {
    try {
      await writeResourceAnnotation(slug, {
        payload: { url: r.url, verdict: "rejected", rationale: r.reason },
        collectionId,
        annotatorVersion: "learn-hunt-resources@critique-gate",
      });
      written += 1;
    } catch (err) {
      logger.error("failed to record a rejected resource", { slug, url: r.url, err: String(err) });
    }
  }

  return written;
}

export const learnResourceHunt = task({
  id: "learn-resource-hunt",
  // The hunt child has already spent from the search pool by the time anything
  // here can fail, so a retry would pay that cost twice for the same result.
  retry: { maxAttempts: 1 },
  run: async (payload: LearnResourceHuntPayload): Promise<LearnResourceHuntResult> => {
    logger.info("starting learn-resource-hunt", { topic: payload.topic });

    const slug = payload.slug ?? (await inferSlug(payload.topic));
    const index = await getWorkspaceIndex(slug);
    const bootstrapped = index === null;

    // One Conversation per learn session, resolved by external_ref (mdrag
    // #1027) so every rerun binds to the SAME one rather than minting a new
    // Conversation per run the way pattern_hunter does. That persistence is
    // the point: a learn session accumulates across runs, and identity lives
    // on the Conversation, not the shared agent (ADR-0030 addendum).
    //
    // It also resolves the Collection. Per ADR-0045 the annotations below are
    // the durable record, and ADR-0015 scopes a Conversation to exactly one
    // Collection — so the Conversation is what says where the record goes.
    const conversation = await resolveOrCreateConversation({
      userId: "learn-resource-hunt",
      ...(payload.userEmail ? { userEmail: payload.userEmail } : {}),
      mode: "learn",
      title: `Learning: ${payload.topic}`.slice(0, 200),
      externalRef: `learn:${slug}`,
    });
    const collectionId = conversation.appliedCollectionId;
    logger.info("bound to learn conversation", {
      slug,
      conversationId: conversation.conversationId,
      collectionId,
      source: conversation.source,
    });

    // Seed a mission only for a workspace that has none. An existing mission is
    // the learner's, and the skill is explicit that changing one is a
    // confirmed decision, not a side effect of a scheduled run.
    if (payload.seedMission && !index?.has_mission) {
      await writeMission(slug, payload.seedMission);
      // The vault write above is the RENDERING; this is the record (ADR-0045).
      // Both, not either — the learner reads MISSION.md, later stages read the
      // annotation.
      if (collectionId) {
        await writeMissionAnnotation(slug, {
          payload: { topic: payload.topic, goal: payload.seedMission },
          collectionId,
          annotatorVersion: "learn-resource-hunt@seed",
          provenance: "human",
        });
      }
      logger.info("seeded mission", { slug });
    }

    const hunt = await learnHuntResources
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
      // The rejections are still worth recording even with nothing kept —
      // that is precisely the run whose work would otherwise be repeated
      // verbatim next time.
      const rejectedWritten = await recordResourceVerdicts(
        slug,
        collectionId,
        [],
        hunt.rejected
      );
      return {
        slug,
        topic: payload.topic,
        kept: 0,
        rejected: hunt.rejected.length,
        bootstrapped,
        conversationId: conversation.conversationId,
        collectionId,
        annotationsWritten: rejectedWritten,
      };
    }

    const refId = await writeReference(
      slug,
      "Resources",
      renderResourcesHtml(payload.topic, hunt.resources, payload.gaps ?? [], new Date().toISOString())
    );

    // The RESOURCES document above is one rendered page a human reads. These
    // are the per-resource records a later stage reads back: which sources
    // cleared the gate, why, and what each one does NOT cover — the field that
    // makes the next hunt targeted instead of a repeat (ADR-0045).
    const annotationsWritten = await recordResourceVerdicts(
      slug,
      collectionId,
      hunt.resources,
      hunt.rejected
    );

    logger.info("completed learn-resource-hunt", {
      slug,
      refId,
      kept: hunt.resources.length,
      rejected: hunt.rejected.length,
      annotationsWritten,
      bootstrapped,
    });

    return {
      slug,
      topic: payload.topic,
      refId,
      kept: hunt.resources.length,
      rejected: hunt.rejected.length,
      bootstrapped,
      conversationId: conversation.conversationId,
      collectionId,
      annotationsWritten,
    };
  },
});
