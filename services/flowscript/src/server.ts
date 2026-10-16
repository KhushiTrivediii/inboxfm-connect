import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { compileFlowSource } from './compiler.js'
import { executeFlowIR } from './runtime.js'
import { closeStore, createRun, deployFlow, finishRun, getDeployedFlow, getRun, initializeStore, listRuns, publishFlow } from './store.js'

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

  // These routes are intended for the private service network. The API gateway
  // must authenticate callers and inject a verified project ID before exposure.
  const projectIdFrom = (request: { headers: Record<string, string | string[] | undefined> }) => {
    const value = request.headers['x-project-id']
    return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null
  }

  app.post('/v1/flows/publish', async (request, reply) => {
    const projectId = projectIdFrom(request)
    if (!projectId) return reply.code(401).send({ error: 'Verified x-project-id header is required from the trusted API gateway' })
    const body = z.object({ source: z.string().min(1).max(1_000_000) }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Expected { source: string }', issues: body.error.issues })
    const compiled = compileFlowSource(body.data.source)
    if (!compiled.ok) return reply.code(422).send({ valid: false, diagnostics: compiled.diagnostics })
    const version = await publishFlow(projectId, body.data.source, compiled.ir, compiled.hash)
    return reply.code(201).send(version)
  })

  app.post('/v1/flows/:name/deploy', async (request, reply) => {
    const projectId = projectIdFrom(request)
    if (!projectId) return reply.code(401).send({ error: 'Verified x-project-id header is required from the trusted API gateway' })
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    const body = z.object({ versionId: z.string().uuid(), environment: z.string().min(1).max(64).default('production') }).safeParse(request.body)
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid deployment request' })
    try {
      return await deployFlow(projectId, body.data.versionId, body.data.environment)
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Deployment failed' })
    }
  })

  app.post('/v1/flows/:name/run', async (request, reply) => {
    const projectId = projectIdFrom(request)
    if (!projectId) return reply.code(401).send({ error: 'Verified x-project-id header is required from the trusted API gateway' })
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    const body = z.object({ input: z.record(z.string(), z.unknown()).default({}), environment: z.string().min(1).max(64).default('production') }).safeParse(request.body ?? {})
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid run request' })
    const deployed = await getDeployedFlow(projectId, params.data.name, body.data.environment)
    if (!deployed) return reply.code(404).send({ error: 'No active deployment for this flow and environment' })
    if (deployed.ir.steps.some(step => step.kind === 'integration')) {
      return reply.code(501).send({ error: 'Integration execution is not wired to the trusted Connect runtime yet; no run was started.' })
    }
    const runId = await createRun({ projectId, flowName: params.data.name, environment: body.data.environment, versionId: deployed.id, input: body.data.input, triggerKind: 'manual' })
    try {
      const result = await executeFlowIR(deployed.ir, { input: body.data.input, trigger: { source: 'api', kind: 'manual' } })
      await finishRun(runId, result)
      return reply.code(result.status === 'succeeded' ? 200 : 422).send({ runId, ...result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Execution failed'
      await finishRun(runId, { status: 'failed', steps: [], error: message })
      return reply.code(500).send({ runId, status: 'failed', error: message })
    }
  })

  app.get('/v1/runs', async (request, reply) => {
    const projectId = projectIdFrom(request)
    if (!projectId) return reply.code(401).send({ error: 'Verified x-project-id header is required from the trusted API gateway' })
    const query = z.object({ flow: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: 'Invalid query parameters' })
    return { runs: await listRuns(projectId, query.data.flow, query.data.limit) }
  })

  app.get('/v1/runs/:id', async (request, reply) => {
    const projectId = projectIdFrom(request)
    if (!projectId) return reply.code(401).send({ error: 'Verified x-project-id header is required from the trusted API gateway' })
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'Invalid run ID' })
    const run = await getRun(projectId, params.data.id)
    return run ? run : reply.code(404).send({ error: 'Run not found' })
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
initializeStore()
  .then(() => app.listen({ host: env.FLOWSCRIPT_HOST, port: env.FLOWSCRIPT_PORT }))
  .then(address => app.log.info({ address }, 'FlowScript service listening'))
  .catch(error => {
    app.log.error({ error }, 'Failed to start FlowScript service')
    process.exitCode = 1
  })

process.once('SIGTERM', () => { void closeStore().finally(() => process.exit(0)) })
process.once('SIGINT', () => { void closeStore().finally(() => process.exit(0)) })
