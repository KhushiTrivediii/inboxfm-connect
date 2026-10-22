import { describe, expect, it } from 'vitest';
import {
  HISTORY_TOKEN_BUDGET,
  estimateHistoryTokens,
  estimateTokens,
  trimHistoryToBudget,
  historyBudgetFor,
} from '../src/lib/common/history-guard';

function buildMessages(count: number, charsPerMessage: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index}-`.padEnd(charsPerMessage, 'x'),
  }));
}

describe('trimHistoryToBudget on top of the count cap (issue #385)', () => {
  it('keeps a small history unchanged without mutating the input', () => {
    const messages = buildMessages(5, 40);
    const snapshot = JSON.parse(JSON.stringify(messages));
    const result = trimHistoryToBudget(messages, 1000);
    expect(result).toEqual(messages);
    expect(messages).toEqual(snapshot);
  });

  it('trims under the count cap when messages are large', () => {
    // 30 messages x ~4000 tokens each: passes the 30-message count cap but
    // far exceeds the 32k budget.
    const messages = buildMessages(30, 16000);
    const result = trimHistoryToBudget(messages);
    expect(result.length).toBeLessThan(messages.length);
    expect(estimateHistoryTokens(result)).toBeLessThanOrEqual(HISTORY_TOKEN_BUDGET);
    // survivors are the newest messages (a contiguous tail)
    expect(result[result.length - 1]).toEqual(messages[messages.length - 1]);
  });

  it('keeps at least one message when a single entry exceeds the budget', () => {
    const messages = buildMessages(3, 100000);
    const result = trimHistoryToBudget(messages, 10);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('estimates string content at ~4 chars/token and never returns NaN', () => {
    expect(estimateTokens({ content: 'x'.repeat(400) })).toBe(100);
    expect(Number.isFinite(estimateTokens({ content: undefined }))).toBe(true);
  });
});

describe('role-aware head after trimming (review #386)', () => {
  it('drops leading assistant turns so the head is a user turn', () => {
    // Front-trimming strands an assistant message at the head; OpenAI-compatible
    // providers reject user-first sequencing violations on the next request.
    const messages = [
      ...buildMessages(10, 40).map((m, i) => ({ ...m, role: i < 4 ? 'assistant' : 'user' })),
    ]
    const result = trimHistoryToBudget(messages, 50) // forces a deep trim
    expect(result.length).toBeGreaterThanOrEqual(1)
    if (result.length > 1) {
      expect(result[0].role).toBe('user')
    }
  })
})

describe('model-window budgets (review #386 round 3)', () => {
  it('derives the budget from the model real context window, capped at 32k', () => {
    // a 1M-window model gets the full 32k system cap
    expect(historyBudgetFor('gpt-4.1')).toBe(32000)
    // a 2048-window unknown model gets ~1861 (window / 1.1), never the full 32k
    expect(historyBudgetFor('unknown-model')).toBe(1861)
    // budgets never drop below the 1000 floor
    expect(historyBudgetFor('tiny-model')).toBeGreaterThanOrEqual(1000)
  })
})

describe('model-first passthrough (review #386 round 3)', () => {
  it('passes an in-budget model-first history through untouched (non-blocking round 3)', () => {
    const messages = [
      { role: 'model', content: 'x'.repeat(100) },
      ...buildMessages(3, 40),
    ]
    const result = trimHistoryToBudget(messages, 10_000)
    expect(result).toEqual(messages)
  })
})
