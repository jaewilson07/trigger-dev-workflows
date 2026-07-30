import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Set after the one-time project creation at https://triggers.datacrew.space
  // (see .env.example) — TRIGGER_API_URL/TRIGGER_SECRET_KEY point the CLI/SDK
  // at the self-hosted instance; this ref identifies the project within it.
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
});
