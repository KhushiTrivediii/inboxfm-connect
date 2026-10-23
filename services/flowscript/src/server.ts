import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { basename, resolve } from 'node:path'
import { z } from 'zod'
import { compileFlowSource, validateRunInput } from './compiler.js'
import { executeFlowIR } from './runtime.js'
import {
  closeStore,
  createRun,
  deployFlow,
  rollbackFlow,
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
  cancelRun,
  replayRun,
  listStepAttempts,
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
  stripUntrustedProjectHeaders,
} from './auth.js'

export {
  getSafeExecutionEnv,
  getGatewaySecret,
  signProjectId,
  generateProjectToken,
  verifyProjectIdentity,
  stripUntrustedProjectHeaders,
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return reply.code(statusCode).send({
    statusCode,
    code,
    error: message,
    message,
    requestId: reply.request.id,
    ...extra,
  })
}

export function buildServer(): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    genReqId(req) {
      const incoming = req.headers['x-request-id']
      if (typeof incoming === 'string' && incoming.trim().length > 0 && incoming.length <= 128) {
        return incoming.trim()
      }
      return randomUUID()
    },
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

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  app.setErrorHandler((error: any, request, reply) => {
    const statusCode = error?.statusCode ?? 500
    let code = error?.code
    if (statusCode === 413 || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      code = 'PAYLOAD_TOO_LARGE'
    } else if (code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      code = 'BAD_REQUEST'
    } else if (!code) {
      if (statusCode === 400) code = 'BAD_REQUEST'
      else if (statusCode === 401) code = 'UNAUTHORIZED'
      else if (statusCode === 403) code = 'FORBIDDEN'
      else if (statusCode === 404) code = 'NOT_FOUND'
      else if (statusCode === 422) code = 'UNPROCESSABLE_ENTITY'
      else code = 'INTERNAL_SERVER_ERROR'
    }
    const msg = error?.message ?? 'An unexpected error occurred'
    reply.code(statusCode).send({
      statusCode,
      code,
      error: msg,
      message: msg,
      requestId: request.id,
    })
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
    if (!body.success) return sendError(reply, 400, 'BAD_REQUEST', 'Expected { source: string }', { issues: body.error.issues })
    const result = compileFlowSource(body.data.source)
    if (!result.ok) {
      return reply.code(422).send({
        statusCode: 422,
        code: 'UNPROCESSABLE_ENTITY',
        error: 'Flow compilation failed',
        message: 'Flow compilation failed',
        requestId: request.id,
        valid: false,
        diagnostics: result.diagnostics,
      })
    }
    return { valid: true, hash: result.hash, ir: result.ir, diagnostics: result.diagnostics }
  })

  app.post('/v1/ir/execute-local', async (request, reply) => {
    const body = z.object({
      flow: FlowIRSchema,
      input: z.record(z.string(), z.unknown()).optional(),
      trigger: z.record(z.string(), z.unknown()).optional(),
    }).safeParse(request.body)
    if (!body.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid execution request', { issues: body.error.issues })
    const validated = validateFlowIR(body.data.flow)
    if (!validated.valid) return sendError(reply, 422, 'UNPROCESSABLE_ENTITY', 'Invalid Flow IR', { valid: false, issues: validated.issues })
    if (validated.flow.steps.some(step => step.kind === 'integration')) {
      return sendError(reply, 501, 'NOT_IMPLEMENTED', 'Trusted InboxFM Connect integration executor is not wired into this service yet; integration steps are never executed by this endpoint.')
    }
    const inputValidation = validateRunInput(validated.flow.inputSchema ?? {}, body.data.input ?? {})
    if (!inputValidation.ok) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid execution input', { diagnostics: inputValidation.diagnostics })
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
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const body = z.object({ source: z.string().min(1).max(1_000_000) }).safeParse(request.body)
    if (!body.success) return sendError(reply, 400, 'BAD_REQUEST', 'Expected { source: string }', { issues: body.error.issues })
    const compiled = compileFlowSource(body.data.source)
    if (!compiled.ok) {
      return reply.code(422).send({
        statusCode: 422,
        code: 'UNPROCESSABLE_ENTITY',
        error: 'Flow compilation failed',
        message: 'Flow compilation failed',
        requestId: request.id,
        valid: false,
        diagnostics: compiled.diagnostics,
      })
    }
    const version = await publishFlow(projectId, body.data.source, compiled.ir, compiled.hash)
    return reply.code(201).send(version)
  })

  app.post('/v1/flows/:name/deploy', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    if (!params.success) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid deployment request', {
        issues: params.error.issues,
      })
    }
    const body = z.object({ versionId: z.string().uuid(), environment: z.string().min(1).max(64).default('production') }).safeParse(request.body)
    if (!body.success) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid deployment request', {
        issues: body.error.issues,
      })
    }
    try {
      return await deployFlow(projectId, params.data.name, body.data.versionId, body.data.environment)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Deployment failed'
      if (msg.includes('belongs to flow')) {
        return sendError(reply, 400, 'FLOW_NAME_MISMATCH', msg)
      }
      if (msg.includes('not found in this project')) {
        return sendError(reply, 404, 'VERSION_NOT_FOUND', msg)
      }
      return sendError(reply, 422, 'DEPLOYMENT_FAILED', msg)
    }
  })

  

  app.post('/v1/flows/:name/rollback', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    if (!params.success) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid flow name', { issues: params.error.issues })
    }
    const body = z.object({ environment: z.string().min(1).max(64).default('production') }).safeParse(request.body ?? {})
    if (!body.success) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid rollback request', { issues: body.error.issues })
    }
    try {
      return await rollbackFlow(projectId, params.data.name, body.data.environment)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Rollback failed'
      if (msg.includes('No previous version') || msg.includes('No active deployment')) {
        return sendError(reply, 404, 'ROLLBACK_NOT_FOUND', msg)
      }
      return sendError(reply, 422, 'ROLLBACK_FAILED', msg)
    }
  })

  app.post('/v1/flows/:name/triggers', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    if (!params.success) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid trigger request', {
        issues: params.error.issues,
      })
    }
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
    if (!body.success) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid trigger request', {
        issues: body.error.issues,
      })
    }

    if (body.data.kind === 'schedule') {
      const scheduleValidation = validateScheduleConfig(body.data.cron, body.data.timezone, { missedTickPolicy: body.data.missedTickPolicy })
      if (!scheduleValidation.valid) {
        return sendError(reply, 400, 'BAD_REQUEST', scheduleValidation.error, {
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
          ? {
              cron: body.data.cron,
              timezone: body.data.timezone,
              missedTickPolicy: body.data.missedTickPolicy,
            }
          : {},
      })
      return reply.code(201).send(body.data.kind === 'webhook'
        ? { ...trigger, webhookUrl: `/v1/hooks/${trigger.token}` }
        : trigger)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Trigger creation failed'
      const isValidationError = msg.toLowerCase().includes('cron') || msg.toLowerCase().includes('timezone') || msg.toLowerCase().includes('policy')
      return sendError(reply, isValidationError ? 400 : 422, isValidationError ? 'BAD_REQUEST' : 'TRIGGER_CREATION_FAILED', msg)
    }
  })

  app.get('/v1/flows/:name/triggers', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    if (!params.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid flow name')
    const triggers = await listFlowTriggers(projectId, params.data.name)
    return reply.code(200).send(triggers)
  })

  app.patch('/v1/flows/:name/triggers/:triggerId', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128), triggerId: z.string().uuid() }).safeParse(request.params)
    const body = z.object({ enabled: z.boolean() }).safeParse(request.body)
    if (!params.success || !body.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid trigger update request')
    const updated = await updateFlowTrigger(projectId, params.data.name, params.data.triggerId, { enabled: body.data.enabled })
    if (!updated) return sendError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
    return reply.code(200).send(updated)
  })

  app.delete('/v1/flows/:name/triggers/:triggerId', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128), triggerId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid trigger deletion request')
    const deleted = await deleteFlowTrigger(projectId, params.data.name, params.data.triggerId)
    if (!deleted) return sendError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
    return reply.code(204).send()
  })

  app.post('/v1/flows/:name/triggers/:triggerId/rotate', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128), triggerId: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid trigger rotation request')
    const rotated = await rotateWebhookTriggerToken(projectId, params.data.name, params.data.triggerId)
    if (!rotated) return sendError(reply, 404, 'TRIGGER_NOT_FOUND', 'Webhook trigger not found')
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
      return sendError(reply, 404, 'NOT_FOUND', 'Webhook endpoint not found')
    }

    if (request.body !== undefined && request.body !== null && typeof request.body !== 'object') {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid webhook payload; expected a JSON object')
    }

    const bodyObj = (request.body ?? {}) as Record<string, unknown>
    if (Array.isArray(bodyObj)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid webhook payload; expected a JSON object')
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
      return sendError(reply, 404, 'NOT_FOUND', 'Webhook endpoint not found')
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
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128) }).safeParse(request.params)
    const body = z.object({
      input: z.record(z.string(), z.unknown()).default({}),
      environment: z.string().min(1).max(64).default('production'),
      idempotencyKey: z.string().min(1).max(128).optional(),
      maxAttempts: z.number().int().min(1).max(10).optional(),
    }).safeParse(request.body ?? {})
    if (!params.success || !body.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid run request')
    const deployed = await getDeployedFlow(projectId, params.data.name, body.data.environment)
    if (!deployed) return sendError(reply, 404, 'DEPLOYMENT_NOT_FOUND', 'No active deployment for this flow and environment')
    if (deployed.ir.steps.some(step => step.kind === 'integration')) {
      return sendError(reply, 501, 'NOT_IMPLEMENTED', 'Integration execution is not wired to the trusted Connect runtime yet; no run was started.')
    }
    const inputValidation = validateRunInput(deployed.ir.inputSchema ?? {}, body.data.input)
    if (!inputValidation.ok) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid run input', { diagnostics: inputValidation.diagnostics })
    }

    const headerIdemp = request.headers['x-idempotency-key'] ?? request.headers['idempotency-key']
    const idempotencyKey = (typeof headerIdemp === 'string' && headerIdemp.trim().length > 0)
      ? headerIdemp.trim()
      : body.data.idempotencyKey

    const runResult = await createRun({
      projectId,
      flowName: params.data.name,
      environment: body.data.environment,
      versionId: deployed.id,
      input: body.data.input,
      triggerKind: 'manual',
      idempotencyKey,
      maxAttempts: body.data.maxAttempts,
    })

    if (runResult.duplicate) {
      return reply.code(200).header('x-idempotent-replay', 'true').send({
        runId: runResult.id,
        status: 'duplicate',
        flow: params.data.name,
        environment: body.data.environment,
      })
    }

    return reply.code(202).send({
      runId: runResult.id,
      status: 'queued',
      flow: params.data.name,
      environment: body.data.environment,
    })
  })

  app.get('/v1/runs', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const query = z.object({ flow: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query)
    if (!query.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid query parameters')
    return { runs: await listRuns(projectId, query.data.flow, query.data.limit) }
  })

  app.get('/v1/runs/:id', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid run ID')
    const run = await getRun(projectId, params.data.id)
    return run ? run : sendError(reply, 404, 'RUN_NOT_FOUND', 'Run not found')
  })

  app.post('/v1/flows/:name/runs/:id/cancel', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ name: z.string().min(1).max(128), id: z.string().uuid() }).safeParse(request.params)
    const body = z.object({ reason: z.string().optional() }).safeParse(request.body ?? {})
    if (!params.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid cancel request')
    const cancelled = await cancelRun(projectId, params.data.id, body.success ? body.data.reason : undefined)
    if (!cancelled) return sendError(reply, 404, 'RUN_NOT_FOUND', 'Run not found')
    return reply.code(200).send(cancelled)
  })

  app.post('/v1/runs/:id/cancel', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params)
    const body = z.object({ reason: z.string().optional() }).safeParse(request.body ?? {})
    if (!params.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid run ID')
    const cancelled = await cancelRun(projectId, params.data.id, body.success ? body.data.reason : undefined)
    if (!cancelled) return sendError(reply, 404, 'RUN_NOT_FOUND', 'Run not found')
    return reply.code(200).send(cancelled)
  })

  

  app.post('/v1/runs/:id/replay', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid run ID')
    try {
      const replayed = await replayRun(projectId, params.data.id)
      if (!replayed) return sendError(reply, 404, 'RUN_NOT_FOUND', 'Run not found')
      return reply.code(201).send(replayed)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Replay failed'
      if (msg.includes('Cannot replay')) {
        return sendError(reply, 409, 'CANNOT_REPLAY_ACTIVE_RUN', msg)
      }
      return sendError(reply, 422, 'REPLAY_FAILED', msg)
    }
  })

  app.get('/v1/runs/:id/attempts', async (request, reply) => {
    const auth = verifyProjectIdentity(request)
    if (!auth.valid || !auth.projectId) {
      return sendError(reply, 401, auth.code ?? 'UNAUTHORIZED', auth.error ?? 'Verified x-project-id header is required from the trusted API gateway')
    }
    const projectId = auth.projectId
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params)
    if (!params.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid run ID')
    const run = await getRun(projectId, params.data.id)
    if (!run) return sendError(reply, 404, 'RUN_NOT_FOUND', 'Run not found')
    const attempts = await listStepAttempts(params.data.id)
    return reply.code(200).send({ runId: params.data.id, attempts })
  })

  app.post('/v1/ir/validate', async (request, reply) => {
    const result = validateFlowIR(request.body)
    if (!result.valid) {
      return sendError(reply, 400, 'BAD_REQUEST', 'Invalid Flow IR', { valid: false, issues: result.issues })
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
