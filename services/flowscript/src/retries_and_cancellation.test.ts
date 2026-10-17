import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  cancelRun,
  claimQueuedRun,
  computeBackoff,
  createRun,
  finishRun,
  getRun,
  getStorePool,
  heartbeatRun,
  listRuns,
  listStepAttempts,
  markRunNonIdempotentStep,
  recordStepAttemptFinish,
  recordStepAttemptStart,
  recoverStaleRuns,
  setStorePool,
} from './store.js'
import type { FlowIR } from './compiler.js'
import { executeFlowIR } from './runtime.js'
import { FlowIntegrationError } from './adapter.js'
import { buildServer, signProjectId } from './server.js'

describe('FlowScript durable retries, stale-run recovery, and cancellation (issue #657)', () => {
  let runs: Map<string, any>
  let stepAttempts: Map<string, any>
  let deployments: Map<string, any>
  let mockPool: any
  let originalPool: any
  let app: ReturnType<typeof buildServer>

  beforeEach(() => {
    runs = new Map()
    stepAttempts = new Map()
    deployments = new Map()
    originalPool = getStorePool()
    app = buildServer()

    const executeQuery = async (sql: string, params: any[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      const trimmed = normalized

      if (trimmed.startsWith('SELECT v.id, v.ir, d.flow_name, d.environment') || trimmed.includes('FROM flowscript_deployments')) {
        const [projectId, flowName, env] = params
        for (const dep of deployments.values()) {
          if (dep.project_id === projectId && dep.flow_name === flowName && dep.environment === env && dep.status === 'active') {
            return {
              rows: [{
                id: dep.version_id,
                version_id: dep.version_id,
                flow_name: dep.flow_name,
                environment: dep.environment,
                ir: dep.ir,
              }],
              rowCount: 1,
            }
          }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('FROM flowscript_runs WHERE project_id=$1 AND idempotency_key=$2')) {
        const [projectId, key] = params
        for (const r of runs.values()) {
          if (r.project_id === projectId && r.idempotency_key === key) {
            return { rows: [{ id: r.id, status: r.status }], rowCount: 1 }
          }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('INSERT INTO flowscript_runs')) {
        const [id, projectId, flowName, env, versionId, triggerKind, input, idempotencyKey, maxAttempts] = params
        if (idempotencyKey) {
          for (const r of runs.values()) {
            if (r.project_id === projectId && r.idempotency_key === idempotencyKey) {
              const err = new Error('duplicate key value violates unique constraint')
              ;(err as any).code = '23505'
              throw err
            }
          }
        }
        const record = {
          id,
          project_id: projectId,
          flow_name: flowName,
          environment: env,
          version_id: versionId,
          trigger_kind: triggerKind,
          status: 'queued',
          input: typeof input === 'string' ? JSON.parse(input) : input,
          output: null,
          steps: [],
          error: null,
          worker_id: null,
          lease_expires_at: null,
          attempt_count: 0,
          max_attempts: maxAttempts ?? 3,
          retry_at: null,
          cancellation_reason: null,
          idempotency_key: idempotencyKey ?? null,
          had_non_idempotent_step: false,
          started_at: null,
          finished_at: null,
          created_at: new Date(),
        }
        runs.set(id, record)
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('FROM flowscript_runs r JOIN flowscript_versions v ON v.id=r.version_id') && trimmed.includes("WHERE r.status='queued'")) {
        const now = new Date()
        const eligible = Array.from(runs.values()).filter(r => {
          if (r.status !== 'queued') return false
          if (r.retry_at && new Date(r.retry_at) > now) return false
          return true
        })
        eligible.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        const first = eligible[0]
        if (!first) return { rows: [], rowCount: 0 }
        const dep = Array.from(deployments.values()).find(d => d.version_id === first.version_id)
        return {
          rows: [{
            id: first.id,
            project_id: first.project_id,
            flow_name: first.flow_name,
            ir: dep?.ir ?? { irVersion: 1, name: first.flow_name, version: 1, steps: [] },
            input: first.input,
            trigger_kind: first.trigger_kind,
            attempt_count: first.attempt_count,
            max_attempts: first.max_attempts,
          }],
          rowCount: 1,
        }
      }

      if (trimmed.includes("UPDATE flowscript_runs SET status='running', worker_id=$2, lease_expires_at=$3, attempt_count=$4")) {
        const [id, workerId, leaseExpires, attemptCount] = params
        const r = runs.get(id)
        if (r) {
          r.status = 'running'
          r.worker_id = workerId
          r.lease_expires_at = leaseExpires
          r.attempt_count = attemptCount
          r.started_at = r.started_at || new Date()
          r.retry_at = null
        }
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes("UPDATE flowscript_runs SET lease_expires_at=$3 WHERE id=$1 AND worker_id=$2 AND status='running'")) {
        const [id, workerId, nextLease] = params
        const r = runs.get(id)
        if (r && r.worker_id === workerId && r.status === 'running') {
          r.lease_expires_at = nextLease
          return { rows: [{ status: r.status, cancellation_reason: r.cancellation_reason }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('SELECT status FROM flowscript_runs WHERE id=$1')) {
        const [id] = params
        const r = runs.get(id)
        return r ? { rows: [{ status: r.status }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }

      if (trimmed.includes("FROM flowscript_runs WHERE status='running' AND lease_expires_at < now()")) {
        const now = new Date()
        const expired = Array.from(runs.values()).filter(r => r.status === 'running' && r.lease_expires_at && new Date(r.lease_expires_at) < now)
        return {
          rows: expired.map(r => ({
            id: r.id,
            project_id: r.project_id,
            attempt_count: r.attempt_count,
            max_attempts: r.max_attempts,
            had_non_idempotent_step: r.had_non_idempotent_step,
          })),
          rowCount: expired.length,
        }
      }

      if (trimmed.includes("SET status='uncertain'")) {
        const [id] = params
        const r = runs.get(id)
        if (r) {
          r.status = 'uncertain'
          r.error = 'Worker lease expired after non-idempotent step execution; marked uncertain to prevent duplicate external side effects. Operator intervention required.'
          r.finished_at = new Date()
        }
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes("SET status='queued', retry_at=$2, error='Worker lease expired; re-queued for retry'")) {
        const [id, retryAt] = params
        const r = runs.get(id)
        if (r) {
          r.status = 'queued'
          r.retry_at = retryAt
          r.worker_id = null
          r.lease_expires_at = null
          r.error = 'Worker lease expired; re-queued for retry'
        }
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes("SET status='dead_letter'")) {
        const [id] = params
        const r = runs.get(id)
        if (r) {
          r.status = 'dead_letter'
          r.error = 'Worker lease expired and maximum retry attempts exhausted'
          r.finished_at = new Date()
        }
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('SELECT id, status FROM flowscript_runs WHERE project_id=$1 AND id=$2')) {
        const [projectId, id] = params
        const r = runs.get(id)
        if (r && r.project_id === projectId) {
          return { rows: [{ id: r.id, status: r.status }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes("UPDATE flowscript_runs SET status='cancelled'")) {
        const [id, reason] = params
        const r = runs.get(id)
        if (r) {
          r.status = 'cancelled'
          r.cancellation_reason = reason
          if (trimmed.includes('finished_at=now()')) {
            r.finished_at = new Date()
          }
        }
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('INSERT INTO flowscript_step_attempts')) {
        const [id, runId, stepId, attempt] = params
        const record = {
          id,
          run_id: runId,
          step_id: stepId,
          attempt,
          status: 'running',
          error_code: null,
          error_message: null,
          retryable: null,
          duration_ms: null,
          started_at: new Date(),
          finished_at: null,
        }
        stepAttempts.set(id, record)
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('UPDATE flowscript_step_attempts')) {
        const [id, status, errorCode, errorMsg, retryable, durationMs] = params
        const a = stepAttempts.get(id)
        if (a) {
          a.status = status
          a.error_code = errorCode
          a.error_message = errorMsg
          a.retryable = retryable
          a.duration_ms = durationMs
          a.finished_at = new Date()
        }
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('UPDATE flowscript_runs SET had_non_idempotent_step=true WHERE id=$1')) {
        const [id] = params
        const r = runs.get(id)
        if (r) r.had_non_idempotent_step = true
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('FROM flowscript_step_attempts WHERE run_id=$1')) {
        const [runId] = params
        const matches = Array.from(stepAttempts.values()).filter(a => a.run_id === runId)
        return { rows: matches, rowCount: matches.length }
      }

      if (trimmed.includes('UPDATE flowscript_runs SET status=$2, output=$3, steps=$4, error=$5')) {
        const [id, status, output, stepsJson, error, cancelReason] = params
        const r = runs.get(id)
        if (r) {
          r.status = status
          r.output = output ? JSON.parse(output) : null
          r.steps = stepsJson ? JSON.parse(stepsJson) : []
          r.error = error
          r.cancellation_reason = cancelReason || r.cancellation_reason
          r.finished_at = new Date()
        }
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('FROM flowscript_runs WHERE project_id=$1 AND id=$2')) {
        const [projectId, id] = params
        const r = runs.get(id)
        if (r && r.project_id === projectId) {
          return { rows: [r], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('FROM flowscript_runs WHERE project_id=$1') && trimmed.includes('ORDER BY created_at DESC')) {
        const [projectId, flowName] = params
        const matches = Array.from(runs.values()).filter(r => r.project_id === projectId && (!flowName || r.flow_name === flowName))
        return { rows: matches, rowCount: matches.length }
      }

      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }

      return { rows: [], rowCount: 0 }
    }

    mockPool = {
      query: (sql: string, params?: any[]) => executeQuery(sql, params),
      connect: async () => ({
        query: (sql: string, params?: any[]) => executeQuery(sql, params),
        release: () => {},
      }),
      end: async () => {},
    }

    setStorePool(mockPool)
  })

  afterEach(async () => {
    setStorePool(originalPool)
    await app.close()
  })

  describe('durable leases and claim expiration', () => {
    it('claims a queued run with an active lease and increments attempt count', async () => {
      const runId = '00000000-0000-0000-0000-000000000001'
      deployments.set('dep-1', {
        project_id: 'p1',
        flow_name: 'test-flow',
        environment: 'production',
        version_id: 'v1',
        status: 'active',
        ir: { irVersion: 1, name: 'test-flow', version: 1, steps: [] },
      })
      runs.set(runId, {
        id: runId,
        project_id: 'p1',
        flow_name: 'test-flow',
        environment: 'production',
        version_id: 'v1',
        trigger_kind: 'manual',
        status: 'queued',
        input: {},
        attempt_count: 0,
        max_attempts: 3,
        created_at: new Date(),
      })

      const job = await claimQueuedRun('worker-alpha', 30_000)
      expect(job).not.toBeNull()
      expect(job?.id).toBe(runId)
      expect(job?.attempt_count).toBe(1)
      expect(job?.worker_id).toBe('worker-alpha')
      expect(job?.lease_expires_at).toBeInstanceOf(Date)

      const saved = runs.get(runId)
      expect(saved.status).toBe('running')
      expect(saved.worker_id).toBe('worker-alpha')
      expect(saved.attempt_count).toBe(1)

      // Another worker attempting to claim should find nothing
      const secondClaim = await claimQueuedRun('worker-beta', 30_000)
      expect(secondClaim).toBeNull()
    })

    it('heartbeatRun extends the lease while running', async () => {
      const runId = '00000000-0000-0000-0000-000000000002'
      const initialLease = new Date(Date.now() + 5000)
      runs.set(runId, {
        id: runId,
        project_id: 'p1',
        flow_name: 'test-flow',
        status: 'running',
        worker_id: 'worker-1',
        lease_expires_at: initialLease,
      })

      const hb = await heartbeatRun(runId, 'worker-1', 45_000)
      expect(hb.active).toBe(true)
      expect(hb.cancelled).toBe(false)

      const saved = runs.get(runId)
      expect(new Date(saved.lease_expires_at).getTime()).toBeGreaterThan(initialLease.getTime())
    })

    it('heartbeatRun returns cancelled=true when run was cancelled by user', async () => {
      const runId = '00000000-0000-0000-0000-000000000003'
      runs.set(runId, {
        id: runId,
        project_id: 'p1',
        flow_name: 'test-flow',
        status: 'cancelled',
        worker_id: 'worker-1',
        cancellation_reason: 'User cancelled',
      })

      const hb = await heartbeatRun(runId, 'worker-1', 30_000)
      expect(hb.active).toBe(false)
      expect(hb.cancelled).toBe(true)
    })
  })

  describe('stale-run recovery process', () => {
    it('recovers safely from worker crash when no non-idempotent step was performed', async () => {
      const runId = '00000000-0000-0000-0000-000000000010'
      const expiredLease = new Date(Date.now() - 5000)
      runs.set(runId, {
        id: runId,
        project_id: 'p1',
        flow_name: 'pure-flow',
        status: 'running',
        worker_id: 'dead-worker',
        lease_expires_at: expiredLease,
        attempt_count: 1,
        max_attempts: 3,
        had_non_idempotent_step: false,
      })

      const recovery = await recoverStaleRuns()
      expect(recovery.recoveredCount).toBe(1)
      expect(recovery.retried).toContain(runId)
      expect(recovery.uncertain).toHaveLength(0)

      const saved = runs.get(runId)
      expect(saved.status).toBe('queued')
      expect(saved.worker_id).toBeNull()
      expect(saved.lease_expires_at).toBeNull()
      expect(saved.retry_at).toBeInstanceOf(Date)
      expect(saved.error).toContain('Worker lease expired')
    })

    it('marks run as uncertain if a crash occurred after non-idempotent side effect', async () => {
      const runId = '00000000-0000-0000-0000-000000000011'
      const expiredLease = new Date(Date.now() - 10000)
      runs.set(runId, {
        id: runId,
        project_id: 'p1',
        flow_name: 'send-email-flow',
        status: 'running',
        worker_id: 'crashed-worker',
        lease_expires_at: expiredLease,
        attempt_count: 1,
        max_attempts: 3,
        had_non_idempotent_step: true, // Side effect may have occurred
      })

      const recovery = await recoverStaleRuns()
      expect(recovery.uncertain).toContain(runId)
      expect(recovery.retried).not.toContain(runId)

      const saved = runs.get(runId)
      expect(saved.status).toBe('uncertain')
      expect(saved.error).toContain('Operator intervention required')
      expect(saved.finished_at).toBeDefined()
    })

    it('moves to dead_letter state when max retry attempts are exhausted', async () => {
      const runId = '00000000-0000-0000-0000-000000000012'
      const expiredLease = new Date(Date.now() - 2000)
      runs.set(runId, {
        id: runId,
        project_id: 'p1',
        flow_name: 'failing-flow',
        status: 'running',
        worker_id: 'crashed-worker-3',
        lease_expires_at: expiredLease,
        attempt_count: 3,
        max_attempts: 3, // Exhausted
        had_non_idempotent_step: false,
      })

      const recovery = await recoverStaleRuns()
      expect(recovery.deadLettered).toContain(runId)

      const saved = runs.get(runId)
      expect(saved.status).toBe('dead_letter')
      expect(saved.error).toContain('maximum retry attempts exhausted')
    })
  })

  describe('runtime step retries, backoff, and attempt persistence', () => {
    it('retries transient integration errors up to maxStepAttempts and records step attempts', async () => {
      const recordedStarts: Array<{ stepId: string; attempt: number }> = []
      const recordedFinishes: Array<{ status: string; errorCode?: string; retryable?: boolean }> = []

      let invocationCount = 0
      const mockExecutor = {
        execute: async () => {
          invocationCount++
          if (invocationCount < 3) {
            // Transient rate limit failure
            throw new FlowIntegrationError('RATE_LIMITED', 'Rate limit exceeded', { retryable: true, status: 429 })
          }
          return { data: 'success-after-retries' }
        },
      }

      const ir = {
        irVersion: 1 as const,
        name: 'retry-flow',
        version: 1,
        steps: [{
          id: 'step_api',
          kind: 'integration' as const,
          config: { integration: 'slack', action: 'send', connectionId: 'conn-1' },
          dependsOn: [],
        }],
      }

      const result = await executeFlowIR(ir as unknown as FlowIR, {
        integrationExecutor: mockExecutor,
        maxStepAttempts: 3,
        onStepAttemptStart: async (stepId, attempt) => {
          recordedStarts.push({ stepId, attempt })
          return `att-${attempt}`
        },
        onStepAttemptFinish: async (_, details) => {
          recordedFinishes.push({ status: details.status, errorCode: details.errorCode, retryable: details.retryable })
        },
      })

      expect(result.status).toBe('succeeded')
      expect(invocationCount).toBe(3)
      expect(recordedStarts).toHaveLength(3)
      expect(recordedStarts[0].attempt).toBe(1)
      expect(recordedStarts[1].attempt).toBe(2)
      expect(recordedStarts[2].attempt).toBe(3)

      expect(recordedFinishes).toHaveLength(3)
      expect(recordedFinishes[0].status).toBe('failed')
      expect(recordedFinishes[0].errorCode).toBe('RATE_LIMITED')
      expect(recordedFinishes[0].retryable).toBe(true)
      expect(recordedFinishes[2].status).toBe('succeeded')
    })

    it('does not retry non-retryable authentication or validation failures', async () => {
      let callCount = 0
      const mockExecutor = {
        execute: async () => {
          callCount++
          throw new FlowIntegrationError('AUTHENTICATION_EXPIRED', 'Invalid API token', { retryable: false, status: 401 })
        },
      }

      const ir = {
        irVersion: 1 as const,
        name: 'no-retry-flow',
        version: 1,
        steps: [{
          id: 'auth_step',
          kind: 'integration' as const,
          config: { integration: 'github', action: 'get_repo', connectionId: 'c1' },
          dependsOn: [],
        }],
      }

      const result = await executeFlowIR(ir as unknown as FlowIR, {
        integrationExecutor: mockExecutor,
        maxStepAttempts: 5,
      })

      expect(result.status).toBe('failed')
      expect(callCount).toBe(1) // Immediate failure, no retry
      expect(result.steps[0].attempts).toBe(1)
    })

    it('redacts sensitive credentials and tokens from step attempt error details', async () => {
      const attemptId = 'att-redact-1'
      stepAttempts.set(attemptId, { id: attemptId, run_id: 'r1', step_id: 's1', attempt: 1, status: 'running' })

      await recordStepAttemptFinish(attemptId, {
        status: 'failed',
        errorCode: 'PROVIDER_ERROR',
        errorMessage: 'Authorization failed with bearer token sk_live_secret123456789 and password secret_pass',
      })

      const attempt = stepAttempts.get(attemptId)
      expect(attempt.error_message).not.toContain('sk_live_secret123456789')
      expect(attempt.error_message).not.toContain('secret_pass')
      expect(attempt.error_message).toContain('[REDACTED]')
    })

    it('marks run as containing non-idempotent step when step lacks idempotency key', async () => {
      let nonIdempotentStepReported: string | null = null
      const mockExecutor = {
        execute: async () => ({ status: 'sent' }),
      }

      const ir = {
        irVersion: 1 as const,
        name: 'side-effect-flow',
        version: 1,
        steps: [{
          id: 'step_email',
          kind: 'integration' as const,
          config: { integration: 'sendgrid', action: 'send_mail', connectionId: 'conn-email' },
          dependsOn: [],
        }],
      }

      await executeFlowIR(ir as unknown as FlowIR, {
        integrationExecutor: mockExecutor,
        onNonIdempotentStep: async (stepId) => {
          nonIdempotentStepReported = stepId
        },
      })

      expect(nonIdempotentStepReported).toBe('step_email')
    })
  })

  describe('cancellation lifecycle and AbortSignal propagation', () => {
    it('cancels queued run immediately and updates status to cancelled', async () => {
      const runId = '00000000-0000-0000-0000-000000000020'
      runs.set(runId, {
        id: runId,
        project_id: 'proj_cancel',
        flow_name: 'queued-flow',
        status: 'queued',
      })

      const result = await cancelRun('proj_cancel', runId, 'Cancelled before worker claim')
      expect(result).not.toBeNull()
      expect(result?.status).toBe('cancelled')

      const saved = runs.get(runId)
      expect(saved.status).toBe('cancelled')
      expect(saved.cancellation_reason).toBe('Cancelled before worker claim')
    })

    it('aborts step execution when AbortSignal triggers', async () => {
      const controller = new AbortController()

      const ir = {
        irVersion: 1 as const,
        name: 'multi-step-cancel',
        version: 1,
        steps: [
          {
            id: 'step1',
            kind: 'transform' as const,
            config: { value: 'first' },
            dependsOn: [],
          },
          {
            id: 'step2',
            kind: 'transform' as const,
            config: { value: 'second' },
            dependsOn: ['step1'],
          },
        ],
      }

      // Abort signal right before second step
      controller.abort()

      const result = await executeFlowIR(ir as unknown as FlowIR, {
        signal: controller.signal,
      })

      expect(result.status).toBe('cancelled')
      expect(result.cancelled).toBe(true)
      expect(result.steps).toHaveLength(0) // Did not run remaining steps
    })
  })

  describe('HTTP endpoints for idempotency, cancellation, and step attempts', () => {
    it('POST /v1/flows/:name/run supports idempotency-key and prevents duplicate enqueuing', async () => {
      const projectId = 'proj_http_idemp'
      const sig = signProjectId(projectId)

      deployments.set('dep-idemp', {
        project_id: projectId,
        flow_name: 'test-flow',
        environment: 'production',
        version_id: 'ver-idemp',
        status: 'active',
        ir: { irVersion: 1, name: 'test-flow', version: 1, steps: [] },
      })

      // 1. Initial request with x-idempotency-key header
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/flows/test-flow/run',
        headers: {
          'x-project-id': projectId,
          'x-project-signature': sig,
          'x-idempotency-key': 'user-req-12345',
        },
        payload: {
          input: { query: 'test' },
        },
      })

      expect(res1.statusCode).toBe(202)
      const body1 = res1.json()
      expect(body1.status).toBe('queued')
      const originalRunId = body1.runId

      // 2. Duplicate request with identical idempotency key
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/flows/test-flow/run',
        headers: {
          'x-project-id': projectId,
          'x-project-signature': sig,
          'x-idempotency-key': 'user-req-12345',
        },
        payload: {
          input: { query: 'test' },
        },
      })

      expect(res2.statusCode).toBe(200)
      expect(res2.headers['x-idempotent-replay']).toBe('true')
      const body2 = res2.json()
      expect(body2.runId).toBe(originalRunId)
      expect(body2.status).toBe('duplicate')
      expect(runs.size).toBe(1)
    })

    it('POST /v1/flows/:name/runs/:id/cancel requires gateway auth and marks run cancelled', async () => {
      const projectId = 'proj_cancel_http'
      const sig = signProjectId(projectId)
      const runId = randomUUID()

      runs.set(runId, {
        id: runId,
        project_id: projectId,
        flow_name: 'flow-a',
        status: 'running',
      })

      const res = await app.inject({
        method: 'POST',
        url: `/v1/flows/flow-a/runs/${runId}/cancel`,
        headers: {
          'x-project-id': projectId,
          'x-project-signature': sig,
        },
        payload: {
          reason: 'Manual abort from dashboard',
        },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.status).toBe('cancelled')
      expect(runs.get(runId).status).toBe('cancelled')
    })

    it('GET /v1/runs/:id/attempts returns persisted step attempt history', async () => {
      const projectId = 'proj_attempts'
      const sig = signProjectId(projectId)
      const runId = randomUUID()

      runs.set(runId, {
        id: runId,
        project_id: projectId,
        flow_name: 'flow-a',
        status: 'succeeded',
      })

      stepAttempts.set('att-1', {
        id: 'att-1',
        run_id: runId,
        step_id: 'step_api',
        attempt: 1,
        status: 'failed',
        error_code: 'RATE_LIMITED',
        error_message: 'Too many requests',
        retryable: true,
        duration_ms: 120,
        started_at: new Date(),
        finished_at: new Date(),
      })

      stepAttempts.set('att-2', {
        id: 'att-2',
        run_id: runId,
        step_id: 'step_api',
        attempt: 2,
        status: 'succeeded',
        error_code: null,
        error_message: null,
        retryable: null,
        duration_ms: 150,
        started_at: new Date(),
        finished_at: new Date(),
      })

      const res = await app.inject({
        method: 'GET',
        url: `/v1/runs/${runId}/attempts`,
        headers: {
          'x-project-id': projectId,
          'x-project-signature': sig,
        },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.runId).toBe(runId)
      expect(body.attempts).toHaveLength(2)
      expect(body.attempts[0].attempt).toBe(1)
      expect(body.attempts[0].errorCode).toBe('RATE_LIMITED')
      expect(body.attempts[1].attempt).toBe(2)
      expect(body.attempts[1].status).toBe('succeeded')
    })
  })
})
