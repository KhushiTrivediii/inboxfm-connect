// ---------------------------------------------------------------------------
// Stored-history token budget (issue #385)
//
// The piece already caps stored history by MESSAGE COUNT (30 here), but a
// count cap says nothing about payload size: 30 x 4000-token messages blow
// past every model window and the stored array keeps failing every later
// run. This guard trims oldest-first until the history also fits the token
// budget (~4 chars/token estimate, 32k default), in addition to the count cap.
export const HISTORY_TOKEN_BUDGET = 32000;

// Context windows for the xAI models this piece's deployments run (review #386,
// mirroring the openai sibling's table conventions): grok-4 carries a 1M-token
// window, the beta grok-3 line 256k, older fast/mini 128k. Unknown models keep
// the conservative 2048 fallback so unresolved models never over-admit history.
export const modelTokenLimit = (model: string): number => {
  switch (model) {
    case 'grok-4':
    case 'grok-4-fast':
    case 'grok-4-1':
    case 'grok-4.1':
      return 1000000;
    case 'grok-3-beta':
    case 'grok-3-fast-beta':
    case 'grok-3-mini-beta':
    case 'grok-3.1':
    case 'grok-3.2':
      return 256000;
    case 'grok-2-image-1212':
    case 'grok-2-vision-1212':
    case 'grok-2-1212':
      return 128000;
    default:
      return 2048;
  }
};

// Window-aware budget: the 32k system cap still bounds the stored history, but
// models with smaller real windows get a tighter budget so the guard trims to
// what the model can actually accept (review #386).
export const historyBudgetFor = (model: string): number =>
  Math.min(HISTORY_TOKEN_BUDGET, Math.max(1000, (modelTokenLimit(model) / 1.1) | 0));

export const estimateTokens = (message: { content?: unknown }): number => {
  const text =
    typeof message?.content === 'string'
      ? message.content
      : JSON.stringify(message?.content ?? '');
  return Math.max(1, Math.round(text.length / 4));
};

export const estimateHistoryTokens = (messages: unknown[]): number =>
  messages.reduce<number>(
    (total: number, message: unknown) => total + estimateTokens(message as { content?: unknown }),
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
