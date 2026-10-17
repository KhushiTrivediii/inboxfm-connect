import Fastify, { type FastifyInstance } from 'fastify'
import { fileURLToPath } from 'node:url'
import { basename, resolve } from 'node:path'
import { z } from 'zod'
import { compileFlowSource, validateRunInput } from './compiler.js'
import { executeFlowIR } from './runtime.js'
import {
  closeStore,
  createRun,
  deployFlow,
  finishRun,
  getDeployedFlow,
  getRun,
  initializeStore,
  listRuns,
  publishFlow,
  createFlowTrigger,
  enqueueWebhook,
  listFlowTriggers,
  updateFlowTrigger,
  deleteFlowTrigger,
  rotateWebhookTriggerToken,
  validateScheduleConfig,
} from './store.js'

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
  compilerVersion: z.string().optional(),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  version: z.number().int().positive(),
  description: z.string().optional(),
  sourceHash: z.string().optional(),
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
  const byId = new Map<string, number>()
  const issues: Array<{ path: string; message: string }> = []
  for (const [index, step] of parsed.data.steps.entries()) {
    if (ids.has(step.id)) {
      issues.push({ path: `steps.${index}.id`, message: `Duplicate step id "${step.id}"` })
    }
    ids.add(step.id)
    byId.set(step.id, index)
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

  // Detect dependency cycles in IR
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    const stepIdx = byId.get(id)
    if (stepIdx !== undefined) {
      const step = parsed.data.steps[stepIdx]
      for (const dep of step.dependsOn) {
        if (byId.has(dep) && !visit(dep)) return false
      }
    }
    visiting.delete(id)
    visited.add(id)
    return true
  }
  for (const id of byId.keys()) {
    if (!visit(id)) {
      issues.push({ path: 'steps', message: 'Step dependencies contain a cycle' })
      break
    }
  }

  if (issues.length > 0) return { valid: false, issues }
  return { valid: true, flow: parsed.data }
}

import {
  getSafeExecutionEnv,
  getGatewaySecret,
  signProjectId,
  generateProjectToken,
  verifyProjectIdentity,
} from './auth.js'

export {
  getSafeExecutionEnv,
  getGatewaySecret,
  signProjectId,
  generateProjectToken,
  verifyProjectIdentity,
}

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.FLOWSCRIPT_LOG_LEVEL,
      serializers: {
        req(req) {
          const rawUrl = typeof req.url === 'string' ? req.url : ''
          const sanitizedUrl = rawUrl.replace(/\/v1\/hooks\/[a-zA-Z0-9_-]+/g, '/v1/hooks/[REDACTED]')
          return {
            method: req.method,
            url: sanitizedUrl,
            host: req.host,
            remoteAddress: req.ip,
          }
        },
      },
    },
  })

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
    const inputValidation = validateRunInput(validated.flow.inputSchema ?? {}, body.data.input ?? {})
    if (!inputValidation.ok) {
      return reply.code(400).send({ error: 'Invalid execution input', diagnostics: inputValidation.diagnostics })
    }
    const safeEnv = getSafeExecutionEnv()
    const result = await executeFlowIR(validated.flow as unknown as import('./compiler.js').FlowIR, {
      input: body.data.input,
      trigger: body.data.trigger,
      env: safeEnv,
    })
    return result.status === 'succeeded' ? result : reply.code(422).send(result)
  })

  // These routes are intended for the private service network. The API gateway
  // must authenticate callers and inject a verified project ID before exposure.
  app.post('/v1/flows/publish', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
    const body = z.object({ source: z.string().min(1).max(1_000_000) }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Expected { source: string }', issues: body.error.issues })
    const compiled = compileFlowSource(body.data.source)
    if (!compiled.ok) return reply.code(422).send({ valid: false, diagnostics: compiled.diagnostics })
    const version = await publishFlow(projectId, body.data.source, compiled.ir, compiled.hash)
    return reply.code(201).send(version)
  })

  app.post('/v1/flows/:name/deploy', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    const body = z.object({ versionId: z.string().uuid(), environment: z.string().min(1).max(64).default('production') }).safeParse(request.body)
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid deployment request' })
    try {
      return await deployFlow(projectId, params.data.name, body.data.versionId, body.data.environment)
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Deployment failed' })
    }
  })

  app.post('/v1/flows/:name/triggers', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    const body = z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('schedule'),
        environment: z.string().min(1).max(64).default('production'),
        cron: z.string().min(1).max(128),
        timezone: z.string().min(1).max(128).default('UTC'),
        missedTickPolicy: z.enum(['run-once', 'skip', 'catch-up']).default('run-once'),
      }),
      z.object({ kind: z.literal('webhook'), environment: z.string().min(1).max(64).default('production') }),
    ]).safeParse(request.body)
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid trigger request', issues: body.success ? undefined : body.error.issues })

    if (body.data.kind === 'schedule') {
      const scheduleValidation = validateScheduleConfig(body.data.cron, body.data.timezone, { missedTickPolicy: body.data.missedTickPolicy })
      if (!scheduleValidation.valid) {
        return reply.code(400).send({
          error: scheduleValidation.error,
          path: scheduleValidation.path,
        })
      }
    }

    try {
      const trigger = await createFlowTrigger({
        projectId,
        flowName: params.data.name,
        environment: body.data.environment,
        kind: body.data.kind,
        config: body.data.kind === 'schedule'
          ? { cron: body.data.cron, timezone: body.data.timezone, missedTickPolicy: body.data.missedTickPolicy }
          : {},
      })
      return reply.code(201).send(body.data.kind === 'webhook'
        ? { ...trigger, webhookUrl: `/v1/hooks/${trigger.token}` }
        : trigger)
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : 'Trigger creation failed' })
    }
  })

  app.get('/v1/flows/:name/triggers', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'Invalid flow name' })
    const triggers = await listFlowTriggers(projectId, params.data.name)
    return reply.code(200).send(triggers)
  })

  app.patch('/v1/flows/:name/triggers/:triggerId', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128), triggerId: z.string().uuid() }).safeParse(request.params)
    const body = z.object({ enabled: z.boolean() }).safeParse(request.body)
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid trigger update request' })
    const updated = await updateFlowTrigger(projectId, params.data.name, params.data.triggerId, { enabled: body.data.enabled })
    if (!updated) return reply.code(404).send({ error: 'Trigger not found' })
    return reply.code(200).send(updated)
  })

  app.delete('/v1/flows/:name/triggers/:triggerId', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128), triggerId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'Invalid trigger deletion request' })
    const deleted = await deleteFlowTrigger(projectId, params.data.name, params.data.triggerId)
    if (!deleted) return reply.code(404).send({ error: 'Trigger not found' })
    return reply.code(204).send()
  })

  app.post('/v1/flows/:name/triggers/:triggerId/rotate', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128), triggerId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'Invalid trigger rotation request' })
    const rotated = await rotateWebhookTriggerToken(projectId, params.data.name, params.data.triggerId)
    if (!rotated) return reply.code(404).send({ error: 'Webhook trigger not found' })
    return reply.code(200).send({
      id: rotated.id,
      flowName: rotated.flowName,
      token: rotated.token,
      webhookUrl: `/v1/hooks/${rotated.token}`,
    })
  })

  app.post('/v1/hooks/:token', {
    bodyLimit: 1_048_576,
  }, async (request, reply) => {
    const params = z.object({ token: z.string().min(32).max(128) }).safeParse(request.params)
    if (!params.success) {
      return reply.code(404).send({ error: 'Webhook endpoint not found' })
    }

    if (request.body !== undefined && request.body !== null && typeof request.body !== 'object') {
      return reply.code(400).send({ error: 'Invalid webhook payload; expected a JSON object' })
    }

    const bodyObj = (request.body ?? {}) as Record<string, unknown>
    if (Array.isArray(bodyObj)) {
      return reply.code(400).send({ error: 'Invalid webhook payload; expected a JSON object' })
    }

    // Extract caller idempotency key from header or common provider event ID keys
    const headerIdemp = request.headers['x-idempotency-key'] ?? request.headers['idempotency-key']
    let idempotencyKey: string | undefined
    if (typeof headerIdemp === 'string' && headerIdemp.trim().length > 0) {
      idempotencyKey = headerIdemp.trim()
    } else if (typeof bodyObj.idempotency_key === 'string' && bodyObj.idempotency_key.trim().length > 0) {
      idempotencyKey = bodyObj.idempotency_key.trim()
    } else if (typeof bodyObj.idempotencyKey === 'string' && bodyObj.idempotencyKey.trim().length > 0) {
      idempotencyKey = bodyObj.idempotencyKey.trim()
    } else if (typeof bodyObj.event_id === 'string' && bodyObj.event_id.trim().length > 0) {
      idempotencyKey = bodyObj.event_id.trim()
    } else if (typeof bodyObj.eventId === 'string' && bodyObj.eventId.trim().length > 0) {
      idempotencyKey = bodyObj.eventId.trim()
    } else if (typeof bodyObj.id === 'string' && bodyObj.id.trim().length > 0) {
      idempotencyKey = bodyObj.id.trim()
    }

    const queued = await enqueueWebhook(params.data.token, bodyObj, idempotencyKey)
    if (!queued) {
      return reply.code(404).send({ error: 'Webhook endpoint not found' })
    }

    if (queued.duplicate) {
      return reply.code(200).header('x-idempotent-replay', 'true').send({
        accepted: true,
        runId: queued.runId,
        status: 'duplicate',
      })
    }

    return reply.code(202).send({
      accepted: true,
      runId: queued.runId,
      status: 'queued',
    })
  })

  app.post('/v1/flows/:name/run', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    const body = z.object({ input: z.record(z.string(), z.unknown()).default({}), environment: z.string().min(1).max(64).default('production') }).safeParse(request.body ?? {})
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid run request' })
    const deployed = await getDeployedFlow(projectId, params.data.name, body.data.environment)
    if (!deployed) return reply.code(404).send({ error: 'No active deployment for this flow and environment' })
    if (deployed.ir.steps.some(step => step.kind === 'integration')) {
      return reply.code(501).send({ error: 'Integration execution is not wired to the trusted Connect runtime yet; no run was started.' })
    }
    const inputValidation = validateRunInput(deployed.ir.inputSchema ?? {}, body.data.input)
    if (!inputValidation.ok) {
      return reply.code(400).send({ error: 'Invalid run input', diagnostics: inputValidation.diagnostics })
    }
    const runId = await createRun({ projectId, flowName: params.data.name, environment: body.data.environment, versionId: deployed.id, input: body.data.input, triggerKind: 'manual' })
    return reply.code(202).send({ runId, status: 'queued', flow: params.data.name, environment: body.data.environment })
  })

  app.get('/v1/runs', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
    const query = z.object({ flow: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: 'Invalid query parameters' })
    return { runs: await listRuns(projectId, query.data.flow, query.data.limit) }
  })

  app.get('/v1/runs/:id', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) return reply.code(401).send({ error: auth.error ?? 'Verified x-project-id header is required from the trusted API gateway' })
    const projectId = auth.projectId
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

const isDirectExecution = () => {
  if (!process.argv[1]) return false
  try {
    const scriptPath = resolve(process.argv[1]).toLowerCase()
    const currentPath = fileURLToPath(import.meta.url).toLowerCase()
    if (scriptPath === currentPath) return true
    const base = basename(scriptPath)
    return (base === 'server.ts' || base === 'server.js') && (
      scriptPath.endsWith('/services/flowscript/src/server.ts') ||
      scriptPath.endsWith('\\services\\flowscript\\src\\server.ts') ||
      scriptPath.endsWith('/services/flowscript/dist/server.js') ||
      scriptPath.endsWith('\\services\\flowscript\\dist\\server.js')
    )
  } catch {
    return false
  }
}

if (process.env.NODE_ENV !== 'test' && isDirectExecution()) {
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
}
