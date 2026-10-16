import { describe, expect, it } from 'vitest'
import { validateFlowIR } from './server.js'

const base = {
  irVersion: 1,
  name: 'daily-digest',
  version: 1,
  trigger: { kind: 'manual' },
  inputSchema: {},
  steps: [
    { id: 'fetch', kind: 'integration', config: { integration: 'gmail', action: 'search' }, dependsOn: [] },
    { id: 'digest', kind: 'transform', config: { operation: 'digest' }, dependsOn: ['fetch'] },
  ],
}

describe('validateFlowIR', () => {
  it('accepts a valid minimal flow IR', () => {
    expect(validateFlowIR(base).valid).toBe(true)
  })

  it('rejects unsupported IR versions', () => {
    const result = validateFlowIR({ ...base, irVersion: 2 })
    expect(result.valid).toBe(false)
  })

  it('rejects duplicate step ids', () => {
    const result = validateFlowIR({
      ...base,
      steps: [base.steps[0], { ...base.steps[1], id: 'fetch' }],
    })
    expect(result.valid).toBe(false)
  })

  it('rejects missing dependencies', () => {
    const result = validateFlowIR({
      ...base,
      steps: [{ ...base.steps[0], dependsOn: ['missing'] }],
    })
    expect(result.valid).toBe(false)
  })
})
