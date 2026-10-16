import type { FlowIR } from './compiler.js'

export type StepContext = { input: Record<string, unknown>; trigger: Record<string, unknown>; outputs: Record<string, unknown>; env: Record<string, string | undefined> }
export type IntegrationExecutor = (config: Record<string, unknown>, context: StepContext) => Promise<unknown>
export type RunResult = { status: 'succeeded' | 'failed'; output?: unknown; steps: Array<{ id: string; status: 'succeeded' | 'skipped' | 'failed'; output?: unknown; error?: string; durationMs: number }> }

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

export async function executeFlowIR(
  ir: FlowIR,
  options: { input?: Record<string, unknown>; trigger?: Record<string, unknown>; env?: Record<string, string | undefined>; integrationExecutor?: IntegrationExecutor; maxSteps?: number; stepTimeoutMs?: number } = {},
): Promise<RunResult> {
  const input = options.input ?? {}
  const trigger = options.trigger ?? {}
  const outputs: Record<string, unknown> = {}
  const steps: RunResult['steps'] = []
  const completed = new Set<string>()
  const maxSteps = options.maxSteps ?? 200
  const timeoutMs = options.stepTimeoutMs ?? 30_000
  if (ir.steps.length > maxSteps) throw new Error(`Flow exceeds maximum step count (${maxSteps})`)
  const context = (): StepContext => ({ input, trigger, outputs, env: options.env ?? process.env })

  for (const step of ir.steps) {
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
          output = await Promise.race([
            options.integrationExecutor(config, context()),
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
      outputs[step.id] = output
      completed.add(step.id)
      steps.push({ id: step.id, status: 'succeeded', output, durationMs: Date.now() - started })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown step error'
      steps.push({ id: step.id, status: 'failed', error: message, durationMs: Date.now() - started })
      return { status: 'failed', steps }
    }
  }
  return { status: 'succeeded', output: ir.output ? resolveValue(ir.output, context()) : outputs, steps }
}
