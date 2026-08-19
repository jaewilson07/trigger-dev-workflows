export { syncEnvVars, getSecret, setSecret } from "./infisical.js";
export type { GetSecretOptions, SetSecretOptions } from "./infisical.js";
export { gitAndUv, cloneRepo, runUv, pushWithAuth } from "./git-uv.js";
export type { RunResult, RunUvOptions } from "./git-uv.js";
export {
  normalizeLanguage,
  richText,
  markdownToBlocks,
  extractNotionId,
  notionTokenFromEnv,
  upsertNotionPage,
} from "./notion.js";
export type {
  NotionAnnotations,
  NotionRichText,
  NotionBlock,
  NotionUpsertResult,
} from "./notion.js";
// `mdrag-hop.ts` was never re-exported here even though
// `executive-assistant/lib/mdrag-conversation-resolver.ts` already imported
// `mdragCall`/`mdragCredentialFromEnv`/`MdragCall` straight from
// "@datacrew/trigger-shared" (not a subpath) -- a standing typecheck failure
// (trigger-dev-workflows#106) this line fixes for every consumer, not just
// indb-blues's new one (trigger-dev-workflows#100). #106's OTHER dangling
// references (MDRAG_INTERNAL_SECRET/MDRAG_TOKEN/buildCall inside that file,
// and the unrelated storm-research/mdrag-critique breakage) are still open
// -- this only fixes the export gap, not that file's own missing local
// definitions.
export {
  mdragCall,
  mdragCredentialFromEnv,
  mdragBaseUrl,
  MdragHopError,
  STRIPPING_HOSTS,
} from "./mdrag-hop.js";
export type { MdragCredential, MdragCall } from "./mdrag-hop.js";
