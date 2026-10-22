import { calculateMessagesTokenSize, exceedsHistoryLimit, reduceContextSize } from '../src/lib/common/common'

// Unknown models fall back to ~1 token per 4 chars, which keeps these tests
// deterministic without depending on tiktoken encodings.
const UNKNOWN_MODEL = 'test-unknown-model'

function buildMessages(count: number, charsPerMessage: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index === 0 ? 'system' : 'user',
    content: `${index}-`.padEnd(charsPerMessage, 'x'),
  }))
}

describe('reduceContextSize (issue #184)', () => {
  it('returns short histories unchanged', async () => {
    const messages = buildMessages(4, 40)
    const result = await reduceContextSize(messages, UNKNOWN_MODEL, 1000)
    expect(result).toEqual(messages)
  })

  it('reduces long histories until they fit maxTokens / 1.5', async () => {
    const messages = buildMessages(20, 40)
    const maxTokens = 100
    const result = await reduceContextSize(messages, UNKNOWN_MODEL, maxTokens)
    expect(result.length).toBeLessThan(messages.length)
    const tokens = await calculateMessagesTokenSize(result, UNKNOWN_MODEL)
    expect(tokens).toBeLessThanOrEqual(maxTokens / 1.5)
  })

  it('keeps cutting while a single cutoff is not enough (discarded recursion regression)', async () => {
    const messages = buildMessages(100, 40)
    const maxTokens = 100
    const result = await reduceContextSize(messages, UNKNOWN_MODEL, maxTokens)
    const tokens = await calculateMessagesTokenSize(result, UNKNOWN_MODEL)
    expect(tokens).toBeLessThanOrEqual(maxTokens / 1.5)
  })

  it('does not mutate the input array', async () => {
    const messages = buildMessages(20, 40)
    const snapshot = JSON.parse(JSON.stringify(messages))
    await reduceContextSize(messages, UNKNOWN_MODEL, 100)
    expect(messages).toEqual(snapshot)
  })
})


describe('reduceContextSize with roles budget (issue #379)', () => {
  it('reduces harder when roles tokens consume part of the budget', async () => {
    const messages = buildMessages(20, 40) // 200 tokens
    const maxTokens = 100 // budget 66.6 tokens
    // without roles: history fits at ~60 tokens after cuts
    const noRoles = await reduceContextSize(messages, UNKNOWN_MODEL, maxTokens)
    // with 30 tokens of roles, the effective history budget is 36.6 tokens
    const withRoles = await reduceContextSize(
      messages,
      UNKNOWN_MODEL,
      maxTokens,
      30
    )
    expect(withRoles.length).toBeLessThan(noRoles.length)
    const tokens = await calculateMessagesTokenSize(withRoles, UNKNOWN_MODEL)
    expect(tokens).toBeLessThanOrEqual(maxTokens / 1.5 - 30)
  })

  it('keeps short histories unchanged even with roles present', async () => {
    const messages = buildMessages(3, 40) // 30 tokens
    const result = await reduceContextSize(messages, UNKNOWN_MODEL, 1000, 30)
    expect(result).toEqual(messages)
  })
})

describe('exceedsHistoryLimit with roles tokens (issue #379)', () => {
  it('history that fits alone trips the guard with a large system prompt', async () => {
    // history alone is under the limit
    const history = buildMessages(20, 100) // 500 tokens
    const historyTokens = await calculateMessagesTokenSize(history, UNKNOWN_MODEL)
    expect(exceedsHistoryLimit(historyTokens, UNKNOWN_MODEL, 100)).toBe(false)

    // roles/system tokens ride on every request; combined size trips the guard
    const roles = buildMessages(60, 100) // 1500 tokens
    const rolesTokens = await calculateMessagesTokenSize(roles, UNKNOWN_MODEL)
    expect(exceedsHistoryLimit(historyTokens + rolesTokens, UNKNOWN_MODEL, 100)).toBe(true)
  })
})
  
describe('reduceContextSize edge cases (codeant follow-ups)', () => {
  it('does not throw on legacy stored messages missing content', async () => {
    // legacy rows can carry undefined/null content; the estimator must not
    // crash reading string.length on them. Missing content counts as zero
    // tokens, so a history of only-empty rows is returned as-is.
    const messages = [
      { role: 'user' },
      { role: 'user', content: null },
    ]
    const result = await reduceContextSize(messages as any, UNKNOWN_MODEL, 100)
    expect(result).toEqual(messages as any)
  })

  it('cuts to zero-ish footprint when roles consume the whole budget', async () => {
    const messages = buildMessages(20, 40) // 200 tokens
    const maxTokens = 100 // budget 66.6 - rolesTokenLength
    // roles consume the entire budget and more: budget goes negative
    const withRoles = await reduceContextSize(
      messages,
      UNKNOWN_MODEL,
      maxTokens,
      100
    )
    // the loop must not stop at 1 oversized message just because
    // length > 1 is false - single message that still exceeds a negative
    // budget should be dropped to empty (or 0-length), not returned as-is
    expect(withRoles.length).toBe(0)
  })
})
