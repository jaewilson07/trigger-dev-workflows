import { task, logger } from "@trigger.dev/sdk";

/**
 * Trivial hello-world task — exists only to prove the indb-blues project's
 * plumbing (deploy + live-trigger via the documented Bearer + User-Agent
 * pattern, see this repo's AGENTS.md) ahead of the real tasks landing in
 * #98-#101. Returns a fixed, structured payload; no external services.
 */
export const indbBluesHello = task({
  id: "indb-blues-hello",
  maxDuration: 60,
  run: async (payload: { name?: string } = {}) => {
    const name = payload.name ?? "world";
    logger.info("indb-blues-hello invoked", { name });

    return {
      message: `Hello from indb-blues, ${name}!`,
      project: "indb-blues",
    };
  },
});
