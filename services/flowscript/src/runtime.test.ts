import { describe, expect, it } from 'vitest'
import { compileFlowSource } from './compiler.js'
import { executeFlowIR } from './runtime.js'

const source = `flow: hello-world
version: 1
trigger:
  kind: manual
inputSchema: {}
steps:
  - id: greeting
    kind: transform
    config:
      value:
        message: hello
        name:
          $ref: input.name
    dependsOn: []
output:
  greeting:
    $ref: steps.greeting
`

describe('executeFlowIR', () => {
  it('runs pure transform steps and resolves references', async () => {
    const compiled = compileFlowSource(source)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const result = await executeFlowIR(compiled.ir, { input: { name: 'Mihir' } })
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ greeting: { message: 'hello', name: 'Mihir' } })
  })

  it('refuses integration execution without a trusted adapter', async () => {
    const compiled = compileFlowSource(source.replace('kind: transform', 'kind: integration'))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const result = await executeFlowIR(compiled.ir)
    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('No trusted integration executor')
  })

  it('enforces the maximum step count', async () => {
    const compiled = compileFlowSource(source)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    await expect(executeFlowIR(compiled.ir, { maxSteps: 0 })).rejects.toThrow('maximum step count')
  })
})
