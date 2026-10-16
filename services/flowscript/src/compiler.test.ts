import { describe, expect, it } from 'vitest'
import { compileFlowSource } from './compiler.js'

const valid = `flow: hello-world
version: 1
trigger:
  kind: manual
steps:
  - id: greeting
    kind: transform
    config:
      value:
        message: hello
    dependsOn: []
output:
  greeting:
    $ref: steps.greeting
`

describe('compileFlowSource', () => {
  it('compiles valid source into deterministic versioned IR', () => {
    const first = compileFlowSource(valid)
    const second = compileFlowSource(valid)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(first.ir.irVersion).toBe(1)
      expect(first.ir.name).toBe('hello-world')
      expect(first.hash).toBe(second.hash)
    }
  })

  it('reports syntax and schema errors without throwing', () => {
    expect(compileFlowSource('flow: [bad').ok).toBe(false)
    expect(compileFlowSource('notAFlow: true').ok).toBe(false)
  })

  it('rejects unknown dependencies', () => {
    const result = compileFlowSource(valid.replace('dependsOn: []', 'dependsOn: [missing]'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some(item => item.code === 'FLOW_UNKNOWN_DEPENDENCY')).toBe(true)
  })

  it('rejects dependency cycles', () => {
    const source = valid.replace('  - id: greeting\n    kind: transform\n    config:\n      value:\n        message: hello\n    dependsOn: []', '  - id: first\n    kind: transform\n    config: { value: 1 }\n    dependsOn: [second]\n  - id: second\n    kind: transform\n    config: { value: 2 }\n    dependsOn: [first]')
    const result = compileFlowSource(source)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some(item => item.code === 'FLOW_DEPENDENCY_CYCLE')).toBe(true)
  })
})
