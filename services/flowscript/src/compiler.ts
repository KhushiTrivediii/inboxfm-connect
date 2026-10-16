import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { z } from 'zod'

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
  name: string
  version: number
  description?: string
  trigger: z.infer<typeof TriggerSchema>
  inputSchema: Record<string, unknown>
  steps: Array<z.infer<typeof StepSchema>>
  output?: Record<string, unknown>
}
export type Diagnostic = { severity: 'error' | 'warning'; code: string; path: string; message: string }
export type CompileResult = { ok: true; ir: FlowIR; hash: string; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] }

export function compileFlowSource(source: string): CompileResult {
  let parsed: unknown
  try {
    parsed = parse(source, { uniqueKeys: true, maxAliasCount: 0 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid FlowScript source'
    return { ok: false, diagnostics: [{ severity: 'error', code: 'FLOW_PARSE_ERROR', path: '$', message }] }
  }
  const validated = SourceSchema.safeParse(parsed)
  if (!validated.success) {
    return {
      ok: false,
      diagnostics: validated.error.issues.map(issue => ({
        severity: 'error',
        code: 'FLOW_SCHEMA_ERROR',
        path: issue.path.map(String).join('.') || '$',
        message: issue.message,
      })),
    }
  }

  const flow = validated.data
  const diagnostics: Diagnostic[] = []
  const byId = new Map<string, number>()
  flow.steps.forEach((step, index) => {
    if (byId.has(step.id)) diagnostics.push({ severity: 'error', code: 'FLOW_DUPLICATE_STEP', path: `steps.${index}.id`, message: `Duplicate step id "${step.id}"` })
    else byId.set(step.id, index)
  })
  flow.steps.forEach((step, index) => {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) diagnostics.push({ severity: 'error', code: 'FLOW_UNKNOWN_DEPENDENCY', path: `steps.${index}.dependsOn`, message: `Unknown dependency "${dependency}"` })
      if (dependency === step.id) diagnostics.push({ severity: 'error', code: 'FLOW_SELF_DEPENDENCY', path: `steps.${index}.dependsOn`, message: 'A step cannot depend on itself' })
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
  for (const id of byId.keys()) {
    if (!visit(id)) {
      diagnostics.push({ severity: 'error', code: 'FLOW_DEPENDENCY_CYCLE', path: 'steps', message: 'Step dependencies contain a cycle' })
      break
    }
  }

  if (diagnostics.some(d => d.severity === 'error')) return { ok: false, diagnostics }
  const ir: FlowIR = {
    irVersion: 1,
    name: flow.flow,
    version: flow.version,
    ...(flow.description ? { description: flow.description } : {}),
    trigger: flow.trigger,
    inputSchema: flow.inputSchema,
    steps: flow.steps,
    ...(flow.output ? { output: flow.output } : {}),
  }
  const canonical = JSON.stringify(ir)
  return { ok: true, ir, hash: createHash('sha256').update(canonical).digest('hex'), diagnostics }
}
