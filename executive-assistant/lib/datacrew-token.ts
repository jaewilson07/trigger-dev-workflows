/**
 * Shared `dc_` JWT credential for every gateway this project calls as
 * itself: mdrag's `/api/v1/*` router (`lib/mdrag-primitives.ts`,
 * `lib/mdrag-seen-articles.ts`, ...), and — since Phase 4 of
 * `.agents/plans/two-gateway-llm-convergence.md` — bonker's completion
 * gateway (`lib/completion-gateway.ts`) and the generalized Letta gateway
 * (`lib/letta-gateway.ts`).
 *
 * Moved out of `mdrag-seen-articles.ts` (where this lived pre-Phase-4, mdrag
 * calls being the only caller so far) so gateway callers don't import a
 * mdrag-specific module for an org-wide credential. `DATACREW_API_TOKEN` is
 * already synced from Infisical (`/datacrew`) into this Trigger.dev
 * project's env (`trigger.config.ts`'s `SYNCED_SECRETS`) — one token, same
 * source, for every `dc_`-gated service this project talks to.
 *
 * NOTE ON SCOPES. A `dc_` token's scopes are asserted by datacrew-site at
 * mint time (ADR-003), not chosen by the caller. Whether the deployed
 * `DATACREW_API_TOKEN` already carries the `llm-gateway`/`letta-gateway`
 * scopes the completion/letta gateways require (`gateway/auth_datacrew.py`,
 * `letta-shim/src/dc_auth.ts`) is an operational question outside this
 * repo's code, not something this client can inspect or change — same class
 * of activation step as flipping `LLM_GATEWAY_REQUIRE_AUTH` to `true`
 * (Phase 0), which Phase 4 makes safe but does not itself flip.
 */

/** Read `DATACREW_API_TOKEN` once per call — empty string when unset. */
export function resolveDatacrewToken(): string {
  return process.env.DATACREW_API_TOKEN ?? "";
}
