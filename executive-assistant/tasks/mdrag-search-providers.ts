import { task, logger } from "@trigger.dev/sdk";
import { callMdragPrimitive, type MdragPrimitiveResponse } from "../lib/mdrag-primitives.js";

/**
 * datacrew#336 — thin wrapper over mdrag's `POST /api/v1/primitives/search-providers`
 * (mdrag issue #899), the "Exa semantic search" slot in datacrew#336's mapping table.
 * Request/response types are derived from mdrag's generated OpenAPI schema
 * (`lib/mdrag-schema.ts`), not hand-mirrored — see trigger-dev-workflows#9.
 *
 * Always calls `provider="web"` (mdrag's `SearxngResult`, `provider_type = "web"`)
 * — the only Provider Deep Researcher needs; Deep Researcher has no concept of a
 * per-caller `available_providers` set the way Pattern Hunter's evidence search
 * does, so this hardcodes the single-Provider auth-bound list mdrag's endpoint
 * requires (`provider` MUST be a member of `available_providers` — see the
 * router's own "Auth-bounding" docstring section — deny-by-default, never an
 * unbounded fallback).
 *
 * `hydrate: false` deliberately — mdrag's default-hydrate behavior does a live
 * page crawl (`crawl4ai`) per hit, which is slower and adds a second failure
 * surface this workflow doesn't need: `title`/`url`/`snippet` alone are already
 * enough to build a grounded `EvidenceResult` (see `deep-research-query.ts`),
 * exactly the same "just the snippet" grounding
 * `tasks/pattern-hunter-pain-points.ts`'s `buildEvidenceItems` already relies on
 * for its own evidence sources.
 */

export type MdragSearchProvidersPayload = {
  text: string;
  limit?: number;
};

/**
 * The subset of one `ProviderResult`'s fields common to every Provider
 * subclass (`title`/`url`/`snippet` — see mdrag's `src/providers/models.py`,
 * `ProviderResult` base class) that this task actually consumes. Provider-
 * specific extras (`engine`/`score`/`published_date` on a `SearxngResult`) are
 * present on the wire but intentionally untyped/unused here — this workflow
 * only ever requests `provider="web"` and only ever needs the base fields.
 */
export type MdragSearchHit = {
  title: string;
  url: string;
  snippet?: string | null;
};

/**
 * mdrag's `SearchProvidersResponse`, schema-derived — EXCEPT `results`, which
 * mdrag declares `list[dict]` (each item is a Provider subclass's own
 * `model_dump()`, so the schema types it as opaque `{[k]: unknown}[]`). We
 * narrow just that field to {@link MdragSearchHit} — the base fields this
 * workflow actually consumes — while keeping the envelope (`provider`,
 * `hydrated`, `hydration_error`) in sync with the schema.
 */
export type MdragSearchProvidersResult = Omit<
  MdragPrimitiveResponse<"search-providers">,
  "results"
> & {
  results: MdragSearchHit[];
};

const SEARCH_PROVIDER = "web";

export const mdragSearchProviders = task({
  id: "mdrag-search-providers",
  retry: { maxAttempts: 2 },
  run: async (payload: MdragSearchProvidersPayload): Promise<MdragSearchProvidersResult> => {
    logger.info("starting mdrag-search-providers");
    const res = await callMdragPrimitive("search-providers", {
      provider: SEARCH_PROVIDER,
      available_providers: [SEARCH_PROVIDER],
      text: payload.text,
      limit: payload.limit ?? 5,
      hydrate: false,
    });
    // Narrow the opaque `list[dict]` results to the base fields we consume.
    const result = res as MdragSearchProvidersResult;
    logger.info("completed mdrag-search-providers", {
      resultCount: result.results.length,
      hydrated: result.hydrated,
      hydrationError: result.hydration_error ?? null,
    });
    return result;
  },
});
