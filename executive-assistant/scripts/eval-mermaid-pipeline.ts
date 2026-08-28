#!/usr/bin/env -S npx tsx
/**
 * Eval harness for the mermaid pipeline's classify → distill → render →
 * validate stages (datacrew-site#218) — reruns against the REAL gateway/
 * Letta backends, no Trigger.dev deploy involved.
 *
 * WHY NO DEPLOY IS NEEDED HERE: `lib/mermaid-classify.ts`, `-distill.ts`,
 * `-render.ts`, and `-validate.ts` are plain TypeScript modules with no
 * `@trigger.dev/sdk` runtime dependency in their actual logic (only the
 * `task()` wrapper in `tasks/mermaid-*.ts` needs the SDK) — that split was
 * deliberate, specifically so this kind of prompt/threshold iteration
 * never has to wait on a build+Docker+registry-push cycle. This script
 * imports those functions directly and drives them exactly the way
 * `mermaid-pipeline.ts` does, minus Trigger.dev's own orchestration
 * (retries, wait.forToken, run history) — none of which this eval needs.
 *
 * NETWORK NOTE: `lib/mermaid-llm.ts` defaults `GATEWAY_URL` to
 * `http://gateway:7630/...`, a Docker-network-only DNS name (`ai-network`)
 * — unresolvable from bonker's bare host. The gateway container also
 * publishes the same port to `127.0.0.1:7630` on the host, so running this
 * from bonker directly (not inside a container) needs:
 *
 *   GATEWAY_URL=http://localhost:7630/v1/chat/completions npx tsx scripts/eval-mermaid-pipeline.ts
 *
 * Falls back to the user's Letta agent (same as production) if the gateway
 * is unreachable — see lib/mermaid-llm.ts.
 *
 * Scoring:
 * - graph_type accuracy: objective (does classify() match the scenario's
 *   known-correct type).
 * - syntax validity: objective (the real mermaid.parse(), same check the
 *   pipeline itself runs).
 * - structural correctness: LLM-judged against a hand-authored expected
 *   outline per scenario (steps/participants/entities the transcript
 *   actually describes) — the same "does the diagram cover what the
 *   source said, without inventing or dropping anything" question a human
 *   reviewer would ask.
 */

import { classifyGraphType } from "../lib/mermaid-classify.js";
import { distillTranscript } from "../lib/mermaid-distill.js";
import { renderStateless } from "../lib/mermaid-render.js";
import { validateMermaidSyntax } from "../lib/mermaid-validate.js";
import { completeText } from "../lib/mermaid-llm.js";
import type { MermaidGraphType } from "../lib/mermaid-types.js";

type Scenario = {
  name: string;
  transcript: string;
  expectedGraphType: MermaidGraphType;
  /** Plain-English outline of what a correct diagram must cover — the
   * judge's ground truth, not a diagram itself. */
  expectedOutline: string;
};

const SCENARIOS: Scenario[] = [
  {
    name: "rambling-checkout (flowchart, tangents/pauses — the original motivating case)",
    transcript: `So, um, okay so basically what happens is — wait, let me back up. The customer browses products on the site. They browse products, and then, yeah so they add something to the cart. Oh wait, I should mention: if the item is out of stock we show them a waitlist option instead of letting them add to cart. But let's say it's in stock — so they add it to the cart, then go to checkout, enter payment info, and we charge the card. If the card fails we show an error and let them retry. If it succeeds we send a confirmation email and show the order confirmation page.`,
    expectedGraphType: "flowchart",
    expectedOutline: `Steps: browse products -> check stock -> [out of stock: show waitlist option (terminal)] / [in stock: add to cart] -> checkout / enter payment -> charge card -> [fails: show error, allow retry] / [succeeds: send confirmation email AND show order confirmation page]. No step for an assumed prior login (the transcript never mentions one).`,
  },
  {
    name: "quote-escaping (flowchart, single-quoted UI copy — the real production bug)",
    transcript: `When the user clicks the button labeled 'Forgot password?' we send them to the reset page. They enter their email and we show them the message 'Check your inbox' and stop there.`,
    expectedGraphType: "flowchart",
    expectedOutline: `Steps: user clicks a button labeled (containing the exact phrase) "Forgot password?" -> go to reset page -> user enters their email -> show the message (containing the exact phrase) "Check your inbox" -> stop (terminal, no further steps). The diagram must actually render (valid Mermaid syntax) despite the quoted phrases in the labels.`,
  },
  {
    name: "support-ticket (flowchart, 3-way branch + reconverge)",
    transcript: `A support ticket comes in. First we check the priority. If it's urgent, page the on-call engineer immediately. If it's high, assign it to the team lead. If it's normal or low, add it to the backlog. Once assigned or paged, whoever's responsible investigates the issue. If they can fix it, they resolve the ticket and notify the customer. If they can't, they escalate to engineering.`,
    expectedGraphType: "flowchart",
    expectedOutline: `Steps: ticket comes in -> check priority -> [urgent: page on-call engineer] / [high: assign to team lead] / [normal or low: add to backlog] -> (all three converge to) investigate the issue -> [fixable: resolve ticket + notify customer] / [not fixable: escalate to engineering].`,
  },
  {
    name: "two-step-baseline (flowchart, simplest possible case)",
    transcript: `First we validate the input. Then we save it to the database.`,
    expectedGraphType: "flowchart",
    expectedOutline: `Exactly two steps, no branching: validate the input -> save it to the database.`,
  },
  {
    name: "auth-handoff (sequence, 4 participants)",
    transcript: `The mobile app calls the auth service to log in with a username and password. The auth service checks the user database for those credentials. If they're valid, the auth service generates a token and returns it to the app. The app then calls the profile service with that token to fetch the user's profile.`,
    expectedGraphType: "sequence",
    expectedOutline: `Participants: Mobile App, Auth Service, User Database, Profile Service (4 distinct actors). Messages in order: App -> Auth Service (login with username/password), Auth Service -> User Database (check credentials), User Database -> Auth Service (return whether valid), Auth Service -> App (return token), App -> Profile Service (fetch profile using the token). No message should be invented that the transcript doesn't describe (e.g. no separate "logout" or "refresh token" step).`,
  },
  {
    name: "blog-schema (erd, one-to-many x2)",
    transcript: `A blog has posts and each post has many comments. Each post belongs to one author. Authors have a name and an email. Posts have a title and a body. Comments have a body and belong to exactly one post.`,
    expectedGraphType: "erd",
    expectedOutline: `Entities: AUTHOR (attributes: name, email), POST (attributes: title, body), COMMENT (attributes: body). Relationships: AUTHOR to POST is one-to-many (one author has many posts), POST to COMMENT is one-to-many (one post has many comments). No entity or attribute the transcript doesn't mention (e.g. no invented "id" fields beyond what's reasonable as an implicit primary key, no invented "tags" or "category" entity).`,
  },
];

type StageResult<T> = { ok: true; value: T; ms: number } | { ok: false; error: string; ms: number };

async function timed<T>(fn: () => Promise<T>): Promise<StageResult<T>> {
  const start = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - start };
  }
}

const JUDGE_SYSTEM = `You are grading whether a generated diagram spec correctly captures a transcript, against a hand-written expected outline. Respond with ONLY a JSON object (no markdown fences):
{"covers_expected": <0.0-1.0>, "spurious_content": <true|false>, "pass": <true|false>, "notes": "<one or two sentences>"}

"covers_expected": what fraction of the expected outline's content is actually present in the generated spec.
"spurious_content": true if the generated spec invents anything (a step, entity, participant, attribute, or relationship) that neither the transcript nor the expected outline mentions.
"pass": true only if covers_expected >= 0.8 AND spurious_content is false.`;

async function judgeStructure(
  expectedOutline: string,
  transcript: string,
  actualSpec: unknown
): Promise<{ covers_expected: number; spurious_content: boolean; pass: boolean; notes: string } | null> {
  const reply = await completeText(
    JUDGE_SYSTEM,
    `Original transcript:\n${transcript}\n\nExpected outline:\n${expectedOutline}\n\nGenerated spec (JSON):\n${JSON.stringify(actualSpec, null, 2)}`,
    { temperature: 0 }
  );
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function runScenario(scenario: Scenario) {
  console.log(`\n=== ${scenario.name} ===`);

  const classify = await timed(() => classifyGraphType(scenario.transcript));
  if (!classify.ok) {
    console.log(`  classify: ERROR (${classify.ms}ms) — ${classify.error}`);
    return {
      scenario: scenario.name,
      classifyCorrect: false,
      judgePass: false,
      valid: false,
      error: classify.error,
      attemptsUsed: 0,
    };
  }
  const classifyCorrect = classify.value.graph_type === scenario.expectedGraphType;
  console.log(
    `  classify: ${classify.value.graph_type} (confidence ${classify.value.confidence}) — expected ${scenario.expectedGraphType} — ${classifyCorrect ? "OK" : "WRONG"} (${classify.ms}ms)`
  );

  // Use the SCENARIO's known-correct type for the rest of the pipeline —
  // a classify miss is scored on its own, not allowed to cascade into a
  // distill/render failure that isn't really about distill/render.
  const graphType = scenario.expectedGraphType;

  const distill = await timed(() => distillTranscript(graphType, scenario.transcript));
  if (!distill.ok) {
    console.log(`  distill: ERROR (${distill.ms}ms) — ${distill.error}`);
    return {
      scenario: scenario.name,
      classifyCorrect,
      judgePass: false,
      valid: false,
      error: distill.error,
      attemptsUsed: 0,
    };
  }
  console.log(`  distill: ok (${distill.ms}ms)`);

  // Mirrors mermaid-pipeline.ts's real generate+validate loop (up to 3
  // stateless attempts, each fed the previous attempt's parser error) —
  // a single-shot render would understate the deployed pipeline's actual
  // robustness, since that retry loop is exactly what production runs.
  const MAX_ATTEMPTS = 3;
  let diagram = "";
  let validation: import("../lib/mermaid-validate.js").MermaidValidationResult = { valid: false };
  let priorError: string | undefined;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsUsed = attempt;
    const render = await timed(() => renderStateless(graphType, distill.value, priorError));
    if (!render.ok) {
      console.log(`  render attempt ${attempt}: ERROR (${render.ms}ms) — ${render.error}`);
      return { scenario: scenario.name, classifyCorrect, judgePass: false, valid: false, error: render.error };
    }
    diagram = render.value;
    validation = await validateMermaidSyntax(diagram);
    console.log(
      `  render attempt ${attempt} (${render.ms}ms): ${validation.valid ? "VALID" : `INVALID — ${validation.error}`}`
    );
    if (validation.valid) break;
    priorError = validation.error;
  }
  console.log(`  attempts used: ${attemptsUsed}/${MAX_ATTEMPTS}`);
  const render = { value: diagram };

  const judge = await judgeStructure(scenario.expectedOutline, scenario.transcript, distill.value);
  if (!judge) {
    console.log(`  judge: ERROR (no parseable verdict)`);
  } else {
    console.log(
      `  judge: covers_expected=${judge.covers_expected} spurious_content=${judge.spurious_content} pass=${judge.pass} — ${judge.notes}`
    );
  }
  console.log(`  diagram:\n${render.value.split("\n").map((l) => "    " + l).join("\n")}`);

  return {
    scenario: scenario.name,
    classifyCorrect,
    judgePass: judge?.pass ?? false,
    coversExpected: judge?.covers_expected ?? null,
    spuriousContent: judge?.spurious_content ?? null,
    valid: validation.valid,
    validationError: validation.error,
    attemptsUsed,
  };
}

async function main() {
  const results = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario));
  }

  console.log("\n\n=== SUMMARY ===");
  const n = results.length;
  const classifyOk = results.filter((r) => r.classifyCorrect).length;
  const validOk = results.filter((r) => r.valid).length;
  const judgeOk = results.filter((r) => r.judgePass).length;
  console.log(`classify accuracy: ${classifyOk}/${n}`);
  console.log(`syntax valid:      ${validOk}/${n}`);
  console.log(`judge pass:        ${judgeOk}/${n}`);
  console.table(
    results.map((r) => ({
      scenario: r.scenario,
      attempts: r.attemptsUsed,
      classify: r.classifyCorrect ? "OK" : "WRONG",
      valid: r.valid ? "OK" : "INVALID",
      judge: r.judgePass ? "PASS" : "FAIL",
      covers: r.coversExpected,
      spurious: r.spuriousContent,
    }))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
