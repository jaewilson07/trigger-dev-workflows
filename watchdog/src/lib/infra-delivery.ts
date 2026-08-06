/**
 * Delivery vocabulary for the infra health report.
 *
 * `delivered | skipped | failed`, matching
 * `executive-assistant/lib/brief-delivery.ts` deliberately: `skipped` is a
 * RESULT, not an error. A watchdog deployment with no Google credentials is a
 * normal state, and reporting it as a failure would train everyone to ignore
 * the failure count.
 *
 * Copied rather than imported for the reason the composition audit gives (R5):
 * each project has its own `package.json` and `trigger.config.ts` and deploys
 * independently, so cross-project sharing needs a real shared package. The
 * status vocabulary being identical across all three projects is the
 * repo-wide convention that package would eventually formalize.
 */

export type InfraChannel = "slack" | "gdoc" | "notion";

export type InfraDeliveryOutcome =
  | { destination: "slack"; status: "delivered"; channel: string; ts: string }
  | { destination: "gdoc"; status: "delivered"; url: string; documentId: string; created: boolean }
  | { destination: "notion"; status: "delivered"; url: string; pageId: string; created: boolean }
  | { destination: InfraChannel; status: "skipped"; reason: string };

export type InfraDeliveryReport =
  | InfraDeliveryOutcome
  | { destination: InfraChannel; status: "failed"; error: string };

export function infraSkipped(destination: InfraChannel, reason: string): InfraDeliveryOutcome {
  return { destination, status: "skipped", reason };
}
