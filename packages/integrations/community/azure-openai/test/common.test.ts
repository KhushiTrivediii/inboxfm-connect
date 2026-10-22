
import {
  calculateMessagesTokenSize,
  exceedsHistoryLimit,
  historyBudget,
  modelTokenLimit,
  reduceContextSize,
} from '../src/lib/common';

// The real call path (ask-gpt.ts) stores { role, content } objects and passes
// model '' — tiktoken rejects it, so the char-based fallback estimator runs.
// These tests drive the exact production shape instead of plain strings.
const MODEL = '';
const TOKENS_PER_CHAR = 0.25; // fallback: 4 chars ~ 1 token

function buildMessages(count: number, charsPerMessage: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index === 0 ? 'system' : index % 2 === 1 ? 'user' : 'assistant',
    content: `${index}-`.padEnd(charsPerMessage, 'x'),
  }));
}

describe('calculateMessagesTokenSize (production shape)', () => {
  it('counts tokens from message content, not the object shape', async () => {
    const messages = buildMessages(3, 40);
    const tokens = await calculateMessagesTokenSize(messages, MODEL);
    // 3 messages x 40 chars x 0.25 tokens/char = 30 tokens
    expect(tokens).toBe(3 * 40 * TOKENS_PER_CHAR);
  });

  it('returns a finite number, never NaN', async () => {
    const messages = buildMessages(5, 100);
    const tokens = await calculateMessagesTokenSize(messages, MODEL);
    expect(Number.isFinite(tokens)).toBe(true);
  });
});

describe('reduceContextSize (production shape, issue #184)', () => {
  it('returns short histories unchanged without mutating the input', async () => {
    const messages = buildMessages(4, 40);
    const snapshot = JSON.parse(JSON.stringify(messages));
    const result = await reduceContextSize(messages, MODEL, 1000);
    expect(result).toEqual(messages);
    expect(messages).toEqual(snapshot);
  });

  it('reduces long histories until they fit maxTokens / 1.5', async () => {
    const messages = buildMessages(20, 40); // 20 x 10 tokens = 200 tokens
    const maxTokens = 100; // budget 66.6 tokens
    const result = await reduceContextSize(messages, MODEL, maxTokens);
    expect(result.length).toBeLessThan(messages.length);
    const tokens = await calculateMessagesTokenSize(result, MODEL);
    expect(tokens).toBeLessThanOrEqual(maxTokens / 1.5);
  });

  it('keeps cutting while a single cutoff is not enough (regression: discarded recursion)', async () => {
    const messages = buildMessages(100, 40); // 1000 tokens total
    const maxTokens = 100; // budget 66.6 tokens
    const result = await reduceContextSize(messages, MODEL, maxTokens);
    const tokens = await calculateMessagesTokenSize(result, MODEL);
    expect(tokens).toBeLessThanOrEqual(maxTokens / 1.5);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves relative order of the surviving messages', async () => {
    const messages = buildMessages(50, 40);
    const result = await reduceContextSize(messages, MODEL, 100);
    const firstContent = result[0].content;
    const allContents = messages.map((m) => m.content);
    expect(allContents).toContain(firstContent);
    // survivors must be a contiguous tail of the original history
    const firstIndex = allContents.indexOf(firstContent);
    expect(result.map((m) => m.content)).toEqual(
      allContents.slice(firstIndex),
    );
  });
});

describe('exceedsHistoryLimit (guard fires on production shape)', () => {
  it('triggers when the object-shaped history exceeds the budget', async () => {
    const messages = buildMessages(20, 100); // 500 tokens
    const tokenLength = await calculateMessagesTokenSize(messages, MODEL);
    // modelTokenLimit('') = 2048 default, maxTokens 100 -> (2048-100)/1.1 ~ 1770
    expect(tokenLength).toBeGreaterThan(0);
    expect(Number.isFinite(tokenLength)).toBe(true);
    // 500 < 1770 so limit not exceeded here — assert the comparison is real
    expect(exceedsHistoryLimit(tokenLength, MODEL, 100)).toBe(false);
    // now exceed it: 2000 tokens
    const big = buildMessages(80, 100); // 2000 tokens
    const bigTokens = await calculateMessagesTokenSize(big, MODEL);
    expect(exceedsHistoryLimit(bigTokens, MODEL, 100)).toBe(true);
  });

  it('roles tokens count toward the guard: history that fits alone fails with a large system prompt (#342)', async () => {
    // history alone is under the limit
    const history = buildMessages(20, 100); // 500 tokens
    const historyTokens = await calculateMessagesTokenSize(history, MODEL);
    expect(exceedsHistoryLimit(historyTokens, MODEL, 100)).toBe(false);

    // roles/system tokens ride on every request; combined size trips the guard
    const roles = buildMessages(60, 100); // 1500 tokens
    const rolesTokens = await calculateMessagesTokenSize(roles, MODEL);
    expect(exceedsHistoryLimit(historyTokens + rolesTokens, MODEL, 100)).toBe(true);
  });
});


describe('historyBudget: window-derived budgets (issue #377)', () => {
  it('gives a 128k model the full 32k system cap, not ~1.7k', () => {
    // Old behavior: budget derived from completion maxTokens alone capped
    // history at (2048-2048)/1.1 -> 0 tokens of history on the default props.
    // Now: min(32k system cap, 128k window - 2048 completion) / 1.1 -> the cap.
    const budget = historyBudget('gpt-4o', 2048);
    expect(budget).toBe(32000 / 1.1);
    // ~29k of usable history vs ~0 before: the guard no longer truncates
    // aggressively on modern models.
    expect(budget).toBeGreaterThan(10000);
  });

  it('never exceeds the 32k system cap even on 1M-context models', () => {
    expect(historyBudget('gpt-4.1', 2048)).toBe(32000 / 1.1);
  });

  it('subtracts the completion budget from small-window models', () => {
    // gpt-4: 8192 window - 2048 completion -> 5586 usable history
    expect(historyBudget('gpt-4', 2048)).toBe((8192 - 2048) / 1.1);
  });

  it('falls back to the conservative legacy budget for unknown models', () => {
    // '' (unset model prop) and unknown deployments keep the 2048 fallback
    expect(modelTokenLimit('')).toBe(2048);
    expect(historyBudget('', 2048)).toBe((2048 - 2048) / 1.1);
  });
});

describe('modelTokenLimit table (issue #377)', () => {
  // Base gpt-3.5-turbo is 4096 — only the -16k variants carry the larger
  // window (16 * 1024 + 1, the sibling piece's off-by-one convention).
  // Overquoting the base model points the over-admission guard in the
  // wrong direction: 400 rejections are worse than an early truncate.
  const windows: Array<[string, number]> = [
    ['gpt-4o', 128000],
    ['gpt-4o-mini', 128000],
    ['gpt-4.1', 1000000],
    ['gpt-4.1-mini', 1000000],
    ['gpt-4', 8192],
    ['gpt-35-turbo', 4096],
    ['gpt-3.5-turbo', 4096],
    ['gpt-35-turbo-16k', 16 * 1024 + 1],
    ['gpt-3.5-turbo-16k', 16 * 1024 + 1],
  ];

  it.each(windows)('quotes %s at its real context window', (model, window) => {
    expect(modelTokenLimit(model)).toBe(window);
  });

  it('keeps unknown models on the conservative 2048 fallback', () => {
    expect(modelTokenLimit('')).toBe(2048);
    expect(modelTokenLimit('a-custom-finetuned-model')).toBe(2048);
  });
});


// reduceContextSize keeps cutting while a single cutoff is not enough, and
// never mutates the caller's array (regression: the pre-#184 code returned
// the result of one .slice() and let role tokens escape the budget).
describe('reduceContextSize (regression, #184)', () => {
  it('keeps cutting while a single cutoff is not enough (discarded recursion regression)', async () => {
    const messages = buildMessages(100, 40);
    const maxTokens = 100;
    const result = await reduceContextSize(messages, MODEL, maxTokens);
    const tokens = await calculateMessagesTokenSize(result, MODEL);
    expect(tokens).toBeLessThanOrEqual(maxTokens / 1.5);
  });

  it('does not mutate the input array', async () => {
    const messages = buildMessages(20, 40);
    const snapshot = JSON.parse(JSON.stringify(messages));
    await reduceContextSize(messages, MODEL, 100);
    expect(messages).toEqual(snapshot);
  });
});
