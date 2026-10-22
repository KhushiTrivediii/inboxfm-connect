import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { z } from 'zod'

export const FLOWSCRIPT_COMPILER_VERSION = '1.0.0'
export const FLOWSCRIPT_IR_VERSION = 1 as const

export const DiagnosticCodes = {
  FLOW_PARSE_ERROR: 'FLOW_PARSE_ERROR',
  FLOW_SCHEMA_ERROR: 'FLOW_SCHEMA_ERROR',
  FLOW_DUPLICATE_STEP: 'FLOW_DUPLICATE_STEP',
  FLOW_UNKNOWN_DEPENDENCY: 'FLOW_UNKNOWN_DEPENDENCY',
  FLOW_SELF_DEPENDENCY: 'FLOW_SELF_DEPENDENCY',
  FLOW_DEPENDENCY_CYCLE: 'FLOW_DEPENDENCY_CYCLE',
  FLOW_INVALID_REFERENCE: 'FLOW_INVALID_REFERENCE',
  FLOW_INPUT_SCHEMA_MISMATCH: 'FLOW_INPUT_SCHEMA_MISMATCH',
  FLOW_UNSUPPORTED_IR_VERSION: 'FLOW_UNSUPPORTED_IR_VERSION',
  FLOW_UNKNOWN_STEP_KIND: 'FLOW_UNKNOWN_STEP_KIND',
} as const

export type DiagnosticCode = (typeof DiagnosticCodes)[keyof typeof DiagnosticCodes]

const TriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
  z.object({ kind: z.literal('schedule'), cron: z.string().min(1), timezone: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('webhook'), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().startsWith('/') }).strict(),
  z.object({ kind: z.literal('integration-event'), integration: z.string().min(1), trigger: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('polling'), integration: z.string().min(1), trigger: z.string().min(1), intervalSeconds: z.number().int().min(10) }).strict(),
])

const StepSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  kind: z.enum(['integration', 'transform', 'filter']),
  config: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).default([]),
}).strict()

const SourceSchema = z.object({
  flow: z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  version: z.number().int().positive().default(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  trigger: TriggerSchema,
  steps: z.array(StepSchema).max(200),
  output: z.record(z.string(), z.unknown()).optional(),
}).strict()

export type FlowIR = {
  irVersion: 1
  compilerVersion?: string
  name: string
  version: number
  description?: string
  sourceHash?: string
  trigger: z.infer<typeof TriggerSchema>
  inputSchema: Record<string, unknown>
  steps: Array<z.infer<typeof StepSchema>>
  output?: Record<string, unknown>
}
export type Diagnostic = { severity: 'error' | 'warning'; code: string; path: string; message: string }
export type CompileResult = { ok: true; ir: FlowIR; hash: string; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] }

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalizeJson(item)).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const sortedKeys = Object.keys(obj).sort()
  const entries = sortedKeys.map(key => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`)
  return '{' + entries.join(',') + '}'
}

function findReferences(value: unknown, path = ''): Array<{ ref: string; path: string }> {
  const results: Array<{ ref: string; path: string }> = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      results.push(...findReferences(item, path ? `${path}.${index}` : `${index}`))
    })
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$ref === 'string') {
      results.push({ ref: obj.$ref, path })
    }
    for (const [k, v] of Object.entries(obj)) {
      results.push(...findReferences(v, path ? `${path}.${k}` : k))
    }
  }
  return results
}

export function validateRunInput(
  inputSchema: Record<string, unknown>,
  input: Record<string, unknown>,
): { ok: true } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  for (const [key, schemaDef] of Object.entries(inputSchema)) {
    const isRequired = typeof schemaDef === 'object' && schemaDef !== null && (schemaDef as Record<string, unknown>).required === true
    const expectedType = typeof schemaDef === 'object' && schemaDef !== null && typeof (schemaDef as Record<string, unknown>).type === 'string'
      ? (schemaDef as Record<string, unknown>).type as string
      : undefined

    if (isRequired && (input[key] === undefined || input[key] === null)) {
      diagnostics.push({
        severity: 'error',
        code: DiagnosticCodes.FLOW_INPUT_SCHEMA_MISMATCH,
        path: `input.${key}`,
        message: `Required input "${key}" is missing`,
      })
      continue
    }

    if (input[key] !== undefined && input[key] !== null && expectedType) {
      const actualType = typeof input[key]
      if (expectedType === 'string' && actualType !== 'string') {
        diagnostics.push({
          severity: 'error',
          code: DiagnosticCodes.FLOW_INPUT_SCHEMA_MISMATCH,
          path: `input.${key}`,
          message: `Expected input "${key}" to be string, received ${actualType}`,
        })
      } else if (expectedType === 'number' && actualType !== 'number') {
        diagnostics.push({
          severity: 'error',
          code: DiagnosticCodes.FLOW_INPUT_SCHEMA_MISMATCH,
          path: `input.${key}`,
          message: `Expected input "${key}" to be number, received ${actualType}`,
        })
      } else if (expectedType === 'boolean' && actualType !== 'boolean') {
        diagnostics.push({
          severity: 'error',
          code: DiagnosticCodes.FLOW_INPUT_SCHEMA_MISMATCH,
          path: `input.${key}`,
          message: `Expected input "${key}" to be boolean, received ${actualType}`,
        })
      }
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics }
  return { ok: true }
}

export function compileFlowSource(source: string): CompileResult {
  let parsed: unknown
  try {
    parsed = parse(source, { uniqueKeys: true, maxAliasCount: 0 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid FlowScript source'
    return { ok: false, diagnostics: [{ severity: 'error', code: DiagnosticCodes.FLOW_PARSE_ERROR, path: '$', message }] }
  }
  const validated = SourceSchema.safeParse(parsed)
  if (!validated.success) {
    return {
      ok: false,
      diagnostics: validated.error.issues.map(issue => ({
        severity: 'error',
        code: DiagnosticCodes.FLOW_SCHEMA_ERROR,
        path: issue.path.map(String).join('.') || '$',
        message: issue.message,
      })),
    }
  }

  const flow = validated.data
  const diagnostics: Diagnostic[] = []
  const byId = new Map<string, number>()
  flow.steps.forEach((step, index) => {
    if (byId.has(step.id)) {
      diagnostics.push({ severity: 'error', code: DiagnosticCodes.FLOW_DUPLICATE_STEP, path: `steps.${index}.id`, message: `Duplicate step id "${step.id}"` })
    } else {
      byId.set(step.id, index)
    }
  })
  flow.steps.forEach((step, index) => {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) {
        diagnostics.push({ severity: 'error', code: DiagnosticCodes.FLOW_UNKNOWN_DEPENDENCY, path: `steps.${index}.dependsOn`, message: `Unknown dependency "${dependency}"` })
      }
      if (dependency === step.id) {
        diagnostics.push({ severity: 'error', code: DiagnosticCodes.FLOW_SELF_DEPENDENCY, path: `steps.${index}.dependsOn`, message: 'A step cannot depend on itself' })
      }
      const depIndex = byId.get(dependency)
      if (depIndex !== undefined && depIndex > index) {
        diagnostics.push({
          severity: 'error',
          code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
          path: `steps.${index}.dependsOn`,
          message: `Forward dependency not allowed: step "${step.id}" depends on step "${dependency}" which appears later in the flow`,
        })
      }
    }
  })

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    const step = flow.steps[byId.get(id)!]
    visiting.add(id)
    for (const dep of step.dependsOn) {
      if (byId.has(dep) && !visit(dep)) return false
    }
    visiting.delete(id)
    visited.add(id)
    return true
  }
  let hasCycle = false
  for (const id of byId.keys()) {
    if (!visit(id)) {
      diagnostics.push({ severity: 'error', code: DiagnosticCodes.FLOW_DEPENDENCY_CYCLE, path: 'steps', message: 'Step dependencies contain a cycle' })
      hasCycle = true
      break
    }
  }

  const getAncestors = (id: string, cache = new Map<string, Set<string>>()): Set<string> => {
    if (cache.has(id)) return cache.get(id)!
    const ancestors = new Set<string>()
    const stepIndex = byId.get(id)
    if (stepIndex === undefined) return ancestors
    const step = flow.steps[stepIndex]
    for (const dep of step.dependsOn) {
      ancestors.add(dep)
      for (const a of getAncestors(dep, cache)) {
        ancestors.add(a)
      }
    }
    cache.set(id, ancestors)
    return ancestors
  }

  if (!hasCycle) {
    const ancestorCache = new Map<string, Set<string>>()
    flow.steps.forEach((step, index) => {
      const ancestors = getAncestors(step.id, ancestorCache)
      const refs = findReferences(step.config)
      for (const { ref, path } of refs) {
        const fullPath = path ? `steps.${index}.config.${path}` : `steps.${index}.config`
        if (ref.startsWith('input.')) {
          const rootKey = ref.slice(6).split('.')[0]
          if (Object.keys(flow.inputSchema).length > 0 && !(rootKey in flow.inputSchema)) {
            diagnostics.push({
              severity: 'error',
              code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
              path: fullPath,
              message: `Reference "$ref: ${ref}" refers to undeclared input property "${rootKey}"`,
            })
          }
        } else if (ref.startsWith('trigger.')) {
          if (flow.trigger.kind === 'manual') {
            diagnostics.push({
              severity: 'error',
              code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
              path: fullPath,
              message: `Manual triggers do not provide payload data for reference "$ref: ${ref}"`,
            })
          }
        } else if (ref.startsWith('steps.')) {
          const targetStepId = ref.slice(6).split('.')[0]
          if (!byId.has(targetStepId)) {
            diagnostics.push({
              severity: 'error',
              code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
              path: fullPath,
              message: `Reference "$ref: ${ref}" refers to unknown step "${targetStepId}"`,
            })
          } else if (targetStepId === step.id) {
            diagnostics.push({
              severity: 'error',
              code: DiagnosticCodes.FLOW_SELF_DEPENDENCY,
              path: fullPath,
              message: `Step "${step.id}" cannot reference its own output`,
            })
          } else if (!ancestors.has(targetStepId)) {
            diagnostics.push({
              severity: 'error',
              code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
              path: fullPath,
              message: `Step "${step.id}" references step "${targetStepId}" without declaring it in dependsOn`,
            })
          }
        } else {
          diagnostics.push({
            severity: 'error',
            code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
            path: fullPath,
            message: `Unsupported reference "$ref: ${ref}". Expected "input.", "trigger.", or "steps." prefix`,
          })
        }
      }
    })

    if (flow.output) {
      const outputRefs = findReferences(flow.output)
      for (const { ref, path } of outputRefs) {
        const fullPath = path ? `output.${path}` : 'output'
        if (ref.startsWith('input.')) {
          const rootKey = ref.slice(6).split('.')[0]
          if (Object.keys(flow.inputSchema).length > 0 && !(rootKey in flow.inputSchema)) {
            diagnostics.push({
              severity: 'error',
              code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
              path: fullPath,
              message: `Reference "$ref: ${ref}" refers to undeclared input property "${rootKey}"`,
            })
          }
        } else if (ref.startsWith('steps.')) {
          const targetStepId = ref.slice(6).split('.')[0]
          if (!byId.has(targetStepId)) {
            diagnostics.push({
              severity: 'error',
              code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
              path: fullPath,
              message: `Output reference "$ref: ${ref}" refers to unknown step "${targetStepId}"`,
            })
          }
        } else if (ref.startsWith('trigger.')) {
          if (flow.trigger.kind === 'manual') {
            diagnostics.push({
              severity: 'error',
              code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
              path: fullPath,
              message: `Manual triggers do not provide payload data for output reference "$ref: ${ref}"`,
            })
          }
        } else {
          diagnostics.push({
            severity: 'error',
            code: DiagnosticCodes.FLOW_INVALID_REFERENCE,
            path: fullPath,
            message: `Unsupported output reference "$ref: ${ref}"`,
          })
        }
      }
    }
  }

  if (diagnostics.some(d => d.severity === 'error')) return { ok: false, diagnostics }

  const sourceHash = createHash('sha256').update(source).digest('hex')
  const semanticIR = {
    irVersion: FLOWSCRIPT_IR_VERSION,
    compilerVersion: FLOWSCRIPT_COMPILER_VERSION,
    name: flow.flow,
    version: flow.version,
    ...(flow.description ? { description: flow.description } : {}),
    trigger: flow.trigger,
    inputSchema: flow.inputSchema,
    steps: flow.steps,
    ...(flow.output ? { output: flow.output } : {}),
  }
  const canonical = canonicalizeJson(semanticIR)
  const artifactHash = createHash('sha256').update(canonical).digest('hex')
  const ir: FlowIR = {
    ...semanticIR,
    sourceHash,
  }
  return { ok: true, ir, hash: artifactHash, diagnostics }
}
