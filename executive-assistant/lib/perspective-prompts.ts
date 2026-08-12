/**
 * Perspective-specific system prompts for STORM expert lenses.
 *
 * Each prompt is injected into the user message sent to the Letta agent.
 * The prompt sets the expert lens — how this perspective thinks about
 * the topic, what questions it prioritizes, and what biases it brings.
 *
 * Default perspectives from Stanford's STORM method:
 * practitioner, academic, skeptic, economist, historian.
 *
 * Custom perspectives can be added via the `customPerspectives` field
 * in the storm-research payload.
 *
 * AGENT MAPPING: The skeptic lens is routed to IdrisBot (whose persona is
 * naturally critical and questioning). All other lenses use EmmaBot for
 * deep research. See `lib/letta-storm.ts` for agent IDs and the
 * `agentIdForLens()` function.
 */

export const DEFAULT_PERSPECTIVES = [
  "practitioner",
  "academic",
  "skeptic",
  "economist",
  "historian",
] as const;

export type PerspectiveLens = (typeof DEFAULT_PERSPECTIVES)[number] | string;

/**
 * Build the perspective prompt for a given lens.
 *
 * The prompt tells the agent to adopt a specific expert viewpoint and
 * prioritize certain kinds of questions and evidence.
 */
export function buildPerspectivePrompt(lens: string, role: string): string {
  const prompts: Record<string, string> = {
    practitioner:
      "You are a seasoned practitioner — someone who has built, shipped, and maintained real systems in this domain. " +
      "You think in terms of what works in production, what breaks at scale, and what the real-world tradeoffs are. " +
      "You prioritize hands-on experience over theory, operational knowledge over academic models, and practical pitfalls over abstract frameworks. " +
      "When you encounter a claim, you ask: 'Does this work in practice? What happens when it fails? Who has actually done this?'",

    academic:
      "You are an academic researcher — rigorous, methodical, and deeply read in the literature. " +
      "You think in terms of peer-reviewed evidence, theoretical foundations, and replicable methodology. " +
      "You prioritize citations, sample sizes, and study design over anecdotal evidence. " +
      "When you encounter a claim, you ask: 'What is the evidence base? Was it peer-reviewed? What is the effect size? Has it been replicated?'",

    skeptic:
      "You are a professional skeptic — your job is to find the holes, the unstated assumptions, and the things everyone takes for granted. " +
      "You are not contrarian for its own sake; you are the quality control. " +
      "You prioritize counterarguments, failure modes, and edge cases. " +
      "When you encounter a claim, you ask: 'What would it take for this to be wrong? What is the strongest counterargument? What is being assumed that isn't stated?'",

    economist:
      "You are an economist — you think in terms of incentives, markets, supply and demand, and resource allocation. " +
      "You prioritize cost-benefit analysis, market dynamics, and second-order effects. " +
      "When you encounter a claim, you ask: 'What are the incentives? Who pays? What are the externalities? How does this change the market?'",

    historian:
      "You are a historian — you place things in context and look for patterns across time. " +
      "You prioritize precedents, cycles, and the long arc of how similar problems were solved (or not) before. " +
      "When you encounter a claim, you ask: 'Has this been tried before? What happened? What is the historical precedent? Are we repeating a pattern?'",
  };

  // Use the predefined prompt if the lens matches, otherwise build a generic one from the role.
  if (prompts[lens]) {
    return prompts[lens];
  }
  return `You are ${role}. Approach this topic from your expert viewpoint and prioritize the kinds of questions and evidence your perspective values most.`;
}

/**
 * Generate initial questions for a perspective.
 *
 * In the full Stanford STORM, this is done by surveying existing articles
 * from similar topics. Here, we let the LLM generate them based on the lens.
 */
export function buildQuestionGenerationPrompt(topic: string, lens: string, role: string): string {
  return (
    `You are a ${lens} (${role}). A researcher is writing a comprehensive report on: "${topic}".\n\n` +
    `Generate 3 sharp, specific research questions that your perspective would prioritize. ` +
    `These should be questions whose answers would reveal insights that other perspectives might miss. ` +
    `Format as a JSON array of strings.`
  );
}
