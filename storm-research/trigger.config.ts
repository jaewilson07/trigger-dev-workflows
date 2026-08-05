import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { InfisicalSDK } from "@infisical/sdk";

/**
 * storm-research — trigger.dev v4 project config.
 *
 * STORM (Synthesis of Topic Outlines through Retrieval and Multi-perspective
 * question asking) — Stanford OVAL lab method, implemented as a trigger.dev
 * workflow backed by Letta Cloud agents.
 *
 * Create the project on the self-hosted instance:
 *   trigger.dev init --project storm-research
 * Then set TRIGGER_PROJECT_REF in .env (see .env.example).
 */
const SYNCED_SECRETS = [
  "LETTA_API_KEY",
  "DATACREW_SLACK_BOT_TOKEN",
  "GOOGLE_TOKEN_API_KEY",
  "DATACREW_API_TOKEN",
];

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["."],
  maxDuration: 3600,
  build: {
    extensions: [
      syncEnvVars(async (ctx) => {
        if (!process.env.INFISICAL_CLIENT_ID || !process.env.INFISICAL_CLIENT_SECRET) {
          return [];
        }

        const client = new InfisicalSDK({
          siteUrl: process.env.INFISICAL_API_URL ?? "https://infisical.datacrew.space",
        });

        await client.auth().universalAuth.login({
          clientId: process.env.INFISICAL_CLIENT_ID,
          clientSecret: process.env.INFISICAL_CLIENT_SECRET,
        });

        const { secrets } = await client.secrets().listSecrets({
          environment: process.env.INFISICAL_ENVIRONMENT ?? ctx.environment,
          projectId: process.env.INFISICAL_PROJECT_ID ?? "3fbb4296-d4e6-4c17-83ee-b852a57a5e50",
          secretPath: process.env.INFISICAL_SECRET_PATH ?? "/",
          recursive: true,
          viewSecretValue: true,
        });

        const wanted = secrets.filter((s) => SYNCED_SECRETS.includes(s.secretKey));
        const missing = SYNCED_SECRETS.filter(
          (name) => !wanted.some((s) => s.secretKey === name)
        );
        if (missing.length > 0) {
          throw new Error(
            `syncEnvVars: ${missing.join(", ")} not found in Infisical ` +
              `(env ${ctx.environment}).`
          );
        }

        return wanted.map((secret) => ({
          name: secret.secretKey,
          value: secret.secretValue.trim().replace(/^['"]|['"]$/g, ""),
        }));
      }),
    ],
  },
});
