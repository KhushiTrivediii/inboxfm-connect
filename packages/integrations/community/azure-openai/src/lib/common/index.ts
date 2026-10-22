import { encoding_for_model } from 'tiktoken';

export const calculateTokensFromString = (string: string, model: string) => {
  try {
    const encoder = encoding_for_model(model as any);
    const tokens = encoder.encode(string);
    encoder.free();

    return tokens.length;
  } catch (e) {
    // Model not supported by tiktoken, every 4 chars is a token
    return Math.round(string.length / 4);
  }
};

// The stored chat history holds { role, content } message objects (see ask-gpt.ts),
// not plain strings, so the estimator must read the message content. Estimating
// the whole object (e.g. via String(message).length) silently returns NaN and
// disables the context guard entirely.
export const calculateMessagesTokenSize = async (
  messages: { role: string; content: string }[],
  model: string
) => {
  let tokenLength = 0;
  for (const message of messages) {
    tokenLength += calculateTokensFromString(message.content, model);
  }

  return tokenLength;
};

export const reduceContextSize = async (
  messages: { role: string; content: string }[],
  model: string,
  maxTokens: number,
  // Roles/system messages ride along on every request but are not part of the
  // history being reduced; subtract their tokens from the budget so what
  // remains actually fits alongside the system prompt (review #342, item 2).
  rolesTokenLength = 0
) => {
  // TODO: Summarize context instead of cutoff
  // Cut from the front (oldest first) without mutating the caller's array, and
  // keep cutting while the remaining history still exceeds the budget.
  let currentMessages = [...messages];
  while (
    currentMessages.length > 1 &&
    (await calculateMessagesTokenSize(currentMessages, model)) >
      maxTokens / 1.5 - rolesTokenLength
  ) {
    const cutoffSize = Math.max(1, Math.round(currentMessages.length * 0.1));
    currentMessages = currentMessages.slice(cutoffSize);
  }

  return currentMessages;
};

// The history budget is what the model can actually accept as input: its
// context window minus the completion budget, capped by the platform's 32k
// system limit, with the /1.1 safety margin (issue #377). Previously the
// completion maxTokens prop alone drove the limit, so a 128k model with a
// 2048 completion budget throttled history to ~1.7k tokens.
export const historyBudget = (model: string, maxTokens: number): number => {
  const byModelWindow = (modelTokenLimit(model) - maxTokens) / 1.1;
  return Math.min(tokenLimit / 1.1, byModelWindow);
};

export const exceedsHistoryLimit = (
  tokenLength: number,
  model: string,
  maxTokens: number
) => {
  return tokenLength >= historyBudget(model, maxTokens);
};

export const tokenLimit = 32000;

// Context windows for the Azure OpenAI models this piece's deployments run,
// aligned with the openai piece's sibling table (issue #377): base
// gpt-3.5-turbo is 4096 — only the -16k variants are 16k. Unknown models
// keep the conservative 2048 fallback so deployments we cannot resolve to a
// known model never over-admit history.
export const modelTokenLimit = (model: string): number => {
  switch (model) {
    case 'gpt-4o':
    case 'gpt-4o-mini':
      return 128000;
    case 'gpt-4.1':
    case 'gpt-4.1-mini':
      return 1000000;
    case 'gpt-35-turbo':
    case 'gpt-3.5-turbo':
      return 4096;
    case 'gpt-35-turbo-16k':
    case 'gpt-3.5-turbo-16k':
    case 'gpt-35-turbo-1106':
    case 'gpt-3.5-turbo-1106':
      return 16385;
    case 'gpt-4':
      return 8192;
    default:
      return 2048;
  }
};
