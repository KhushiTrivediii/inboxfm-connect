import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { compileFlowSource } from './compiler.js'
import { executeFlowIR } from './runtime.js'

const envSchema = z.object({
  FLOWSCRIPT_HOST: z.string().default('0.0.0.0'),
  FLOWSCRIPT_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  FLOWSCRIPT_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

const env = envSchema.parse(process.env)

const FlowIRStepSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  kind: z.enum(['integration', 'transform', 'filter']),
  config: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string()).default([]),
})

const FlowIRSchema = z.object({
  irVersion: z.literal(1),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  version: z.number().int().positive(),
  trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('schedule'), cron: z.string().min(1), timezone: z.string().min(1) }),
    z.object({ kind: z.literal('webhook'), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().startsWith('/') }),
    z.object({ kind: z.literal('integration-event'), integration: z.string().min(1), trigger: z.string().min(1) }),
    z.object({ kind: z.literal('polling'), integration: z.string().min(1), trigger: z.string().min(1), intervalSeconds: z.number().int().min(10) }),
  ]),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(FlowIRStepSchema).max(200),
  output: z.record(z.string(), z.unknown()).optional(),
}).strict()

export type FlowIR = z.infer<typeof FlowIRSchema>

export function validateFlowIR(value: unknown): { valid: true; flow: FlowIR } | { valid: false; issues: Array<{ path: string; message: string }> } {
  const parsed = FlowIRSchema.safeParse(value)
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map(issue => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    }
  }

  const ids = new Set<string>()
  const issues: Array<{ path: string; message: string }> = []
  for (const [index, step] of parsed.data.steps.entries()) {
    if (ids.has(step.id)) {
      issues.push({ path: `steps.${index}.id`, message: `Duplicate step id "${step.id}"` })
    }
    ids.add(step.id)
  }
  for (const [index, step] of parsed.data.steps.entries()) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        issues.push({ path: `steps.${index}.dependsOn`, message: `Unknown dependency "${dependency}"` })
      }
      if (dependency === step.id) {
        issues.push({ path: `steps.${index}.dependsOn`, message: 'A step cannot depend on itself' })
      }
    }
  }

  if (issues.length > 0) return { valid: false, issues }
  return { valid: true, flow: parsed.data }
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: { level: env.FLOWSCRIPT_LOG_LEVEL } })

  app.get('/health', async () => ({
    status: 'ok',
    service: 'flowscript',
    capabilities: ['ir-validation', 'source-compilation', 'safe-local-execution'],
  }))

  app.get('/ready', async () => ({
    status: 'ready',
    service: 'flowscript',
  }))

  app.post('/v1/source/compile', async (request, reply) => {
    const body = z.object({ source: z.string().min(1).max(1_000_000) }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Expected { source: string }', issues: body.error.issues })
    const result = compileFlowSource(body.data.source)
    if (!result.ok) return reply.code(422).send({ valid: false, diagnostics: result.diagnostics })
    return { valid: true, hash: result.hash, ir: result.ir, diagnostics: result.diagnostics }
  })

  app.post('/v1/ir/execute-local', async (request, reply) => {
    const body = z.object({
      flow: FlowIRSchema,
      input: z.record(z.string(), z.unknown()).optional(),
      trigger: z.record(z.string(), z.unknown()).optional(),
    }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid execution request', issues: body.error.issues })
    const validated = validateFlowIR(body.data.flow)
    if (!validated.valid) return reply.code(422).send({ valid: false, issues: validated.issues })
    if (validated.flow.steps.some(step => step.kind === 'integration')) {
      return reply.code(501).send({ error: 'Trusted InboxFM Connect integration executor is not wired into this service yet; integration steps are never executed by this endpoint.' })
    }
    const result = await executeFlowIR(validated.flow, { input: body.data.input, trigger: body.data.trigger })
    return result.status === 'succeeded' ? result : reply.code(422).send(result)
  })

  app.post('/v1/ir/validate', async (request, reply) => {
    const result = validateFlowIR(request.body)
    if (!result.valid) {
      return reply.code(400).send({ valid: false, issues: result.issues })
    }
    return { valid: true, flow: result.flow }
  })

  return app
}

const app = buildServer()
app.listen({ host: env.FLOWSCRIPT_HOST, port: env.FLOWSCRIPT_PORT })
  .then(address => app.log.info({ address }, 'FlowScript service listening'))
  .catch(error => {
    app.log.error({ error }, 'Failed to start FlowScript service')
    process.exitCode = 1
  })
