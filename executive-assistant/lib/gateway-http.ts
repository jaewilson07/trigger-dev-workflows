/**
 * Shared request/response mechanics for the two `dc_`-JWT-authenticated
 * OpenAI-shaped gateways this project calls (`lib/completion-gateway.ts`,
 * `lib/letta-gateway.ts`): POST a chat-completions body, throw a clear error
 * on a non-2xx status or a malformed 2xx body, otherwise return the first
 * choice's text. Extracted after `/code-review` flagged the two callers
 * duplicating this almost verbatim.
 */

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

/**
 * POST `body` to `url` with `headers` and return `choices[0].message.content`.
 * `errorLabel` prefixes both the non-2xx and the malformed-response errors
 * (e.g. "Completion gateway", "Letta gateway") so a caller's logs/tests can
 * tell which of the two gateways failed.
 */
export async function postChatCompletion(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  errorLabel: string
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${errorLabel} error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (content === undefined) {
    throw new Error(`${errorLabel} returned no choices: ${JSON.stringify(data)}`);
  }
  return content;
}
