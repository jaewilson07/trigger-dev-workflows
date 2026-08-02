import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson, userAgentName } from "./letta-fallback.js";

/**
 * These expectations are NOT hand-computed -- each was produced by running
 * mdrag's own `src/integrations/letta/user_agents.py:user_agent_name`, the
 * canonical implementation. The agent name is a cross-repo lookup key, so a
 * silent drift here would give one person two agents with two separate
 * memories and fail invisibly (both agents work; they just share nothing).
 *
 * If this test fails, do NOT update the expected values to match the code --
 * the code has drifted from mdrag, and that is the bug.
 */
test("userAgentName matches mdrag's derivation", () => {
  assert.equal(userAgentName("jaewilson07@gmail.com"), "mdrag_user_437d47a792cb");
  assert.equal(userAgentName("beth@datacrew.space"), "mdrag_user_e2badd5e256c");
});

test("userAgentName lowercases before hashing", () => {
  // mdrag hashes `email.lower()`; a case-sensitive port would give the same
  // person a second agent depending on how they typed their address.
  assert.equal(userAgentName("JaeWilson07@Gmail.COM"), "mdrag_user_437d47a792cb");
});

test("extractJson handles the wrappers both backends emit", () => {
  const expected = { category: "Newsletter", confidence: 0.9 };
  assert.deepEqual(extractJson('{"category":"Newsletter","confidence":0.9}'), expected);
  assert.deepEqual(extractJson('```json\n{"category":"Newsletter","confidence":0.9}\n```'), expected);
  assert.deepEqual(
    extractJson('<think>weighing it up</think>\n{"category":"Newsletter","confidence":0.9}'),
    expected
  );
  assert.deepEqual(
    extractJson('<tool_call>{"category":"Newsletter","confidence":0.9}</tool_call>'),
    expected
  );
  assert.deepEqual(
    extractJson('Here you go: {"category":"Newsletter","confidence":0.9} — hope that helps.'),
    expected
  );
});

test("extractJson unwraps a tool-call envelope", () => {
  // A model asked for structured output sometimes answers as if CALLING a
  // function instead of returning the payload.
  assert.deepEqual(extractJson('{"name":"triage","arguments":{"category":"Spam"}}'), {
    category: "Spam",
  });
});

test("extractJson returns null rather than guessing", () => {
  assert.equal(extractJson("I cannot help with that."), null);
  assert.equal(extractJson("[1,2,3]"), null, "a JSON array is not a verdict object");
  assert.equal(extractJson(""), null);
});

test("extractJson is not stateful across calls", () => {
  // The strip regexes are module-level and carry the /g flag; a lastIndex
  // leak would make the second identical call behave differently.
  const input = '```json\n{"category":"Client","confidence":0.8}\n```';
  assert.deepEqual(extractJson(input), extractJson(input));
});
