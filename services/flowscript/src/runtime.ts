import type { FlowIR } from './compiler.js'
import { redactSensitiveData, type FlowIntegrationExecutor } from './adapter.js'

export type StepContext = { input: Record<string, unknown>; trigger: Record<string, unknown>; outputs: Record<string, unknown>; env: Record<string, string | undefined> }
export type IntegrationExecutor = (config: Record<string, unknown>, context: StepContext) => Promise<unknown>
export type RunResult = {
  status: 'succeeded' | 'failed'
  output?: unknown
  error?: string
  steps: Array<{ id: string; status: 'succeeded' | 'skipped' | 'failed'; output?: unknown; error?: string; durationMs: number }>
}

function resolvePath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, value)
}

function resolveValue(value: unknown, context: StepContext): unknown {
  if (Array.isArray(value)) return value.map(item => resolveValue(item, context))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$ref === 'string') {
      const ref = obj.$ref
      if (ref.startsWith('input.')) return resolvePath(context.input, ref.slice(6))
      if (ref.startsWith('trigger.')) return resolvePath(context.trigger, ref.slice(8))
      if (ref.startsWith('steps.')) return resolvePath(context.outputs, ref.slice(6))
      throw new Error(`Unsupported reference "${ref}"`)
    }
    if (typeof obj.$env === 'string') {
      const resolved = context.env[obj.$env]
      if (resolved === undefined) throw new Error(`Missing environment variable "${obj.$env}"`)
      return resolved
    }
    return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, resolveValue(item, context)]))
  }
  return value
}

export function topologicallySortSteps<T extends { id: string; dependsOn: string[] }>(steps: T[]): T[] {
  const byId = new Map<string, T>()
  const inDegree = new Map<string, number>()
  const graph = new Map<string, string[]>()

  for (const step of steps) {
    byId.set(step.id, step)
    inDegree.set(step.id, step.dependsOn.length)
    for (const dep of step.dependsOn) {
      const dependents = graph.get(dep) ?? []
      dependents.push(step.id)
      graph.set(dep, dependents)
    }
  }

  const queue: string[] = []
  for (const step of steps) {
    if ((inDegree.get(step.id) ?? 0) === 0) {
      queue.push(step.id)
    }
  }

  const sorted: T[] = []
  while (queue.length > 0) {
    const currentId = queue.shift()!
    const step = byId.get(currentId)
    if (step) {
      sorted.push(step)
    }
    const neighbors = graph.get(currentId) ?? []
    for (const neighborId of neighbors) {
      const updatedDegree = (inDegree.get(neighborId) ?? 1) - 1
      inDegree.set(neighborId, updatedDegree)
      if (updatedDegree === 0) {
        queue.push(neighborId)
      }
    }
  }

  if (sorted.length !== steps.length) {
    return steps
  }

  return sorted
}

export async function executeFlowIR(
  ir: FlowIR,
  options: {
    input?: Record<string, unknown>
    trigger?: Record<string, unknown>
    env?: Record<string, string | undefined>
    integrationExecutor?: IntegrationExecutor | FlowIntegrationExecutor
    projectId?: string
    platformId?: string
    runId?: string
    maxSteps?: number
    stepTimeoutMs?: number
  } = {},
): Promise<RunResult> {
  const input = options.input ?? {}
  const trigger = options.trigger ?? {}
  const outputs: Record<string, unknown> = {}
  const steps: RunResult['steps'] = []
  const completed = new Set<string>()
  const maxSteps = options.maxSteps ?? 200
  const timeoutMs = options.stepTimeoutMs ?? 30_000
  if (ir.steps.length > maxSteps) throw new Error(`Flow exceeds maximum step count (${maxSteps})`)
  const context = (): StepContext => ({ input, trigger, outputs, env: options.env ?? {} })

  const orderedSteps = topologicallySortSteps(ir.steps)
  for (const step of orderedSteps) {
    if (!step.dependsOn.every(id => completed.has(id))) {
      return { status: 'failed', steps: [...steps, { id: step.id, status: 'failed', error: 'Dependency was not completed before this step', durationMs: 0 }] }
    }
    const started = Date.now()
    try {
      const config = resolveValue(step.config, context()) as Record<string, unknown>
      let output: unknown
      if (step.kind === 'integration') {
        if (!options.integrationExecutor) throw new Error('No trusted integration executor is configured; refusing to execute integration step')
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const executor = options.integrationExecutor
          let executionPromise: Promise<unknown>

          if (typeof executor === 'object' && executor !== null && 'execute' in executor) {
            const integrationName = String(config.integration ?? config.pieceName ?? config.integrationName ?? '')
            const actionName = String(config.action ?? config.tool ?? config.actionName ?? '')
            const connectionId = String(config.connectionId ?? '')
            const actionInput = (config.input && typeof config.input === 'object' ? config.input : {}) as Record<string, unknown>

            executionPromise = (executor as FlowIntegrationExecutor).execute({
              projectId: options.projectId ?? 'default-project',
              platformId: options.platformId ?? 'default-platform',
              integrationName,
              actionName,
              connectionId,
              input: actionInput,
              runId: options.runId ?? 'local-run',
              stepId: step.id,
              idempotencyKey: config.idempotencyKey ? String(config.idempotencyKey) : undefined,
            })
          } else {
            executionPromise = (executor as IntegrationExecutor)(config, context())
          }

          output = await Promise.race([
            executionPromise,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms`)), timeoutMs) }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
      } else if (step.kind === 'transform') {
        output = config.value === undefined ? config : resolveValue(config.value, context())
      } else {
        output = config.when === true
      }
      const sanitizedOutput = redactSensitiveData(output)
      outputs[step.id] = sanitizedOutput
      completed.add(step.id)
      steps.push({ id: step.id, status: 'succeeded', output: sanitizedOutput, durationMs: Date.now() - started })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown step error'
      const sanitizedError = redactSensitiveData(message) as string
      steps.push({ id: step.id, status: 'failed', error: sanitizedError, durationMs: Date.now() - started })
      return { status: 'failed', steps }
    }
  }
  try {
    const finalOutput = ir.output ? resolveValue(ir.output, context()) : outputs
    return { status: 'succeeded', output: redactSensitiveData(finalOutput), steps }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Output resolution failed'
    const sanitizedError = redactSensitiveData(message) as string
    return { status: 'failed', steps, error: sanitizedError }
  }
}
