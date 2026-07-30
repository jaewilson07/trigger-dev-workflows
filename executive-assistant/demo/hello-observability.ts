import { task, logger, metadata, wait } from "@trigger.dev/sdk";

/**
 * Self-contained observability demo — no external services (Slack, MongoDB,
 * gateway/cubby, Exa). Its only job is to prove the dev → run → observe loop
 * on triggers.datacrew.space: structured logs, live progress metadata, a
 * traced wait, and a child-task span.
 *
 * Trigger it from the dashboard's "Test" tab (Dev environment) with a payload
 * like { "name": "Jae", "steps": 3 } and watch the run's timeline populate.
 */
export const helloObservability = task({
  id: "hello-observability",
  maxDuration: 120,
  run: async (payload: { name?: string; steps?: number }, { ctx }) => {
    const name = payload.name ?? "world";
    const steps = payload.steps ?? 3;

    logger.info("Starting observability demo", { name, steps, runId: ctx.run.id });
    metadata.set("status", "starting");

    // Each step emits a log + updates run metadata so progress is visible live
    // in the dashboard while the run is still executing.
    for (let step = 1; step <= steps; step++) {
      metadata.set("status", `step ${step}/${steps}`);
      metadata.set("progress", Math.round((step / steps) * 100));
      logger.info(`Working on step ${step}`, { step, of: steps });
      await wait.for({ seconds: 1 });
    }

    // Child task → shows up as a nested span under the parent run's trace when
    // task-to-API networking is available (dev, or a fully-wired deployed env).
    // Kept non-fatal: on a connection error the run still completes with an
    // inline greeting, so the always-on demo never fails on infra.
    let greeting = `Hello, ${name}!`;
    try {
      const enriched = await enrichGreeting.triggerAndWait({ name });
      if (enriched.ok) greeting = enriched.output.greeting;
    } catch (err) {
      logger.warn("Child task unavailable; using inline greeting", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    metadata.set("status", "done");
    logger.info("Observability demo complete", { greeting });

    return {
      greeting,
      steps,
      observedAt: ctx.run.startedAt,
    };
  },
});

/** Trivial child task, exists only to demonstrate a nested trace span. */
export const enrichGreeting = task({
  id: "enrich-greeting",
  run: async (payload: { name: string }) => {
    logger.info("Enriching greeting", { name: payload.name });
    return { greeting: `Hello, ${payload.name}! 👋 (from a child task span)` };
  },
});
