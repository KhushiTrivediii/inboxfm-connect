import { describe, expect, it } from 'vitest';
import {
  HISTORY_TOKEN_BUDGET,
  estimateHistoryTokens,
  estimateTokens,
  trimHistoryToBudget,
} from '../src/lib/history-guard';

function buildMessages(count: number, charsPerMessage: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index}-`.padEnd(charsPerMessage, 'x'),
  }));
}

describe('estimateTokens (issue #381)', () => {
  it('uses the ~4 chars/token approximation on string content', () => {
    expect(estimateTokens({ content: 'x'.repeat(400) })).toBe(100);
  });

  it('falls back to JSON.stringify for non-string content and never returns 0/NaN', () => {
    const tokens = estimateTokens({ content: [{ text: 'y'.repeat(40) }] });
    expect(Number.isFinite(tokens)).toBe(true);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('trimHistoryToBudget (issue #381)', () => {
  it('returns short histories unchanged without mutating the input', () => {
    const messages = buildMessages(4, 40);
    const snapshot = JSON.parse(JSON.stringify(messages));
    const result = trimHistoryToBudget(messages, 1000);
    expect(result).toEqual(messages);
    expect(messages).toEqual(snapshot);
  });

  it('trims long histories from the front until they fit the budget', () => {
    const messages = buildMessages(200, 400); // ~20,000 tokens
    const result = trimHistoryToBudget(messages, 3000);
    expect(result.length).toBeLessThan(messages.length);
    expect(estimateHistoryTokens(result)).toBeLessThanOrEqual(3000);
    // survivors must be the newest messages (a contiguous tail)
    expect(result[result.length - 1]).toEqual(messages[messages.length - 1]);
  });

  it('keeps at least one message even when a single entry exceeds the budget', () => {
    const messages = buildMessages(3, 100000);
    const result = trimHistoryToBudget(messages, 10);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('defaults to the documented 32k system budget', () => {
    expect(HISTORY_TOKEN_BUDGET).toBe(32000);
    // a 50k-token history at the default budget is trimmed
    const messages = buildMessages(500, 400); // ~50,000 tokens
    const result = trimHistoryToBudget(messages);
    expect(estimateHistoryTokens(result)).toBeLessThanOrEqual(32000);
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
