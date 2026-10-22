// ---------------------------------------------------------------------------
// Stored-history context guard (issue #381)
//
// memoryKey flows persist the whole conversation and re-send it on every
// run. Without a bound, a long-running flow grows the stored array until the
// provider rejects it with a 400 context_length_exceeded-style error — and
// keeps failing on every later run because the oversized history is what is
// stored. The guard estimates tokens with a conservative char-based
// approximation (~4 chars/token, no model table needed) and trims the oldest
// entries first until the stored history fits the budget.
export const HISTORY_TOKEN_BUDGET = 32000;

// Gemini's `chat.getHistory()` returns `Content[]` — `{ role, parts: [{ text }] }`
// — with no `content` field (review of #382). Resolve the text from `parts`
// first; `{ role, content }`-shaped entries (the shape this file is tested with
// alongside the Gemini shape) still work through the second branch.
export const estimateTokens = (message: {
  content?: unknown;
  parts?: Array<{ text?: unknown }>;
}): number => {
  let text: string;
  if (Array.isArray(message?.parts)) {
    text = message.parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  } else if (typeof message?.content === 'string') {
    text = message.content;
  } else {
    text = JSON.stringify(message?.content ?? '');
  }
  return Math.max(1, Math.round(text.length / 4));
};

export const estimateHistoryTokens = (messages: unknown[]): number =>
  messages.reduce<number>(
    (total: number, message: unknown) => total + estimateTokens(message as { content?: unknown; parts?: Array<{ text?: unknown }> }),
    0
  );

export const trimHistoryToBudget = <T>(
  messages: T[],
  budget: number = HISTORY_TOKEN_BUDGET
): T[] => {
  let current = [...messages];
  let trimmed = false;
  while (
    current.length > 1 &&
    estimateHistoryTokens(current as unknown[]) > budget
  ) {
    current = current.slice(Math.max(1, Math.round(current.length * 0.1)));
    trimmed = true;
  }
  // Front-trimming can strand an assistant/model turn at the head; providers
  // that enforce user-first sequencing (OpenAI-compatible APIs) reject the
  // next request. Only histories the budget loop actually trimmed get the
  // head-fix — an in-budget history that legitimately starts with a model
  // turn (Gemini accepts model-first) is passed through untouched. Roles and
  // the system prompt are not counted toward the budget; the /1.1 headroom
  // absorbs them on small windows and the 32k cap covers large ones.
  if (trimmed) {
    while (
      current.length > 1 &&
      (current[0] as { role?: unknown }).role !== 'user'
    ) {
      current = current.slice(1);
    }
  }
  return current;
};
