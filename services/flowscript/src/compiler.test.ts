import { describe, expect, it } from 'vitest'
import {
  FLOWSCRIPT_COMPILER_VERSION,
  FLOWSCRIPT_IR_VERSION,
  canonicalizeJson,
  compileFlowSource,
  validateRunInput,
} from './compiler.js'

const valid = `flow: hello-world
version: 1
description: Minimal manual FlowScript flow
trigger:
  kind: manual
inputSchema:
  name:
    type: string
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

describe('compileFlowSource', () => {
  it('compiles valid source into deterministic versioned IR with pinned metadata', () => {
    const first = compileFlowSource(valid)
    const second = compileFlowSource(valid)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(first.ir.irVersion).toBe(FLOWSCRIPT_IR_VERSION)
      expect(first.ir.compilerVersion).toBe(FLOWSCRIPT_COMPILER_VERSION)
      expect(first.ir.name).toBe('hello-world')
      expect(first.ir.sourceHash).toBeDefined()
      expect(first.hash).toBe(second.hash)
      expect(typeof first.hash).toBe('string')
      expect(first.hash.length).toBe(64)
    }
  })

  it('produces identical artifact hash regardless of YAML key ordering (canonical hashing)', () => {
    const reordered = `version: 1
flow: hello-world
description: Minimal manual FlowScript flow
output:
  greeting:
    $ref: steps.greeting
trigger:
  kind: manual
inputSchema:
  name:
    type: string
steps:
  - config:
      value:
        name:
          $ref: input.name
        message: hello
    dependsOn: []
    id: greeting
    kind: transform
`
    const originalResult = compileFlowSource(valid)
    const reorderedResult = compileFlowSource(reordered)
    expect(originalResult.ok).toBe(true)
    expect(reorderedResult.ok).toBe(true)
    if (originalResult.ok && reorderedResult.ok) {
      expect(originalResult.hash).toBe(reorderedResult.hash)
    }
  })

  it('reports syntax and schema errors without throwing', () => {
    const parseErr = compileFlowSource('flow: [bad')
    expect(parseErr.ok).toBe(false)
    if (!parseErr.ok) {
      expect(parseErr.diagnostics[0].code).toBe('FLOW_PARSE_ERROR')
    }

    const schemaErr = compileFlowSource('notAFlow: true')
    expect(schemaErr.ok).toBe(false)
    if (!schemaErr.ok) {
      expect(schemaErr.diagnostics.some(d => d.code === 'FLOW_SCHEMA_ERROR')).toBe(true)
    }
  })

  it('rejects duplicate step IDs', () => {
    const source = `flow: duplicate-steps
version: 1
trigger:
  kind: manual
steps:
  - id: step_one
    kind: transform
    config: { value: 1 }
    dependsOn: []
  - id: step_one
    kind: transform
    config: { value: 2 }
    dependsOn: []
`
    const result = compileFlowSource(source)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics.some(d => d.code === 'FLOW_DUPLICATE_STEP')).toBe(true)
    }
  })

  it('rejects unknown dependencies', () => {
    const result = compileFlowSource(valid.replace('dependsOn: []', 'dependsOn: [missing]'))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics.some(d => d.code === 'FLOW_UNKNOWN_DEPENDENCY')).toBe(true)
    }
  })

  it('rejects self-dependencies', () => {
    const source = `flow: self-dep
version: 1
trigger:
  kind: manual
steps:
  - id: loop
    kind: transform
    config: { value: 1 }
    dependsOn: [loop]
`
    const result = compileFlowSource(source)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics.some(d => d.code === 'FLOW_SELF_DEPENDENCY')).toBe(true)
    }
  })

  it('rejects dependency cycles', () => {
    const source = `flow: cycle
version: 1
trigger:
  kind: manual
steps:
  - id: first
    kind: transform
    config: { value: 1 }
    dependsOn: [second]
  - id: second
    kind: transform
    config: { value: 2 }
    dependsOn: [first]
`
    const result = compileFlowSource(source)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics.some(d => d.code === 'FLOW_DEPENDENCY_CYCLE')).toBe(true)
    }
  })

  it('rejects references to undeclared input properties', () => {
    const source = valid.replace('$ref: input.name', '$ref: input.nonExistentProp')
    const result = compileFlowSource(source)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const diag = result.diagnostics.find(d => d.code === 'FLOW_INVALID_REFERENCE')
      expect(diag).toBeDefined()
      expect(diag?.message).toContain('undeclared input property "nonExistentProp"')
    }
  })

  it('rejects payload references for manual triggers', () => {
    const source = valid.replace('$ref: input.name', '$ref: trigger.body.data')
    const result = compileFlowSource(source)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const diag = result.diagnostics.find(d => d.code === 'FLOW_INVALID_REFERENCE')
      expect(diag).toBeDefined()
      expect(diag?.message).toContain('Manual triggers do not provide payload data')
    }
  })

  it('rejects step references that are not declared in dependsOn', () => {
    const source = `flow: undeclared-dep-ref
version: 1
trigger:
  kind: manual
steps:
  - id: step_a
    kind: transform
    config: { value: 10 }
    dependsOn: []
  - id: step_b
    kind: transform
    config:
      value:
        from_a:
          $ref: steps.step_a.output
    dependsOn: []
`
    const result = compileFlowSource(source)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const diag = result.diagnostics.find(d => d.code === 'FLOW_INVALID_REFERENCE')
      expect(diag).toBeDefined()
      expect(diag?.message).toContain('without declaring it in dependsOn')
    }
  })

  it('rejects step referencing its own output', () => {
    const source = `flow: self-ref
version: 1
trigger:
  kind: manual
steps:
  - id: my_step
    kind: transform
    config:
      value:
        self:
          $ref: steps.my_step.value
    dependsOn: []
`
    const result = compileFlowSource(source)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics.some(d => d.code === 'FLOW_SELF_DEPENDENCY')).toBe(true)
    }
  })

  it('rejects references with invalid prefixes', () => {
    const source = valid.replace('$ref: input.name', '$ref: random.property')
    const result = compileFlowSource(source)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const diag = result.diagnostics.find(d => d.code === 'FLOW_INVALID_REFERENCE')
      expect(diag).toBeDefined()
      expect(diag?.message).toContain('Unsupported reference')
    }
  })
})

describe('canonicalizeJson', () => {
  it('deterministically sorts nested object keys', () => {
    const obj1 = { z: 1, a: { d: 4, b: 2, c: { y: 25, x: 24 } } }
    const obj2 = { a: { c: { x: 24, y: 25 }, b: 2, d: 4 }, z: 1 }
    expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2))
    expect(canonicalizeJson(obj1)).toBe('{"a":{"b":2,"c":{"x":24,"y":25},"d":4},"z":1}')
  })

  it('preserves array element order', () => {
    const arr = [{ b: 1, a: 2 }, { d: 4, c: 3 }]
    expect(canonicalizeJson(arr)).toBe('[{"a":2,"b":1},{"c":3,"d":4}]')
  })
})

describe('validateRunInput', () => {
  const schema = {
    username: { type: 'string', required: true },
    age: { type: 'number' },
    active: { type: 'boolean' },
  }

  it('accepts valid inputs matching schema', () => {
    const result = validateRunInput(schema, { username: 'alice', age: 30, active: true })
    expect(result.ok).toBe(true)
  })

  it('rejects missing required fields', () => {
    const result = validateRunInput(schema, { age: 30 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics[0].code).toBe('FLOW_INPUT_SCHEMA_MISMATCH')
      expect(result.diagnostics[0].message).toContain('Required input "username" is missing')
    }
  })

  it('rejects type mismatches', () => {
    const result = validateRunInput(schema, { username: 'alice', age: 'not a number' as unknown as number })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics[0].code).toBe('FLOW_INPUT_SCHEMA_MISMATCH')
      expect(result.diagnostics[0].message).toContain('Expected input "age" to be number')
    }
  })
})
