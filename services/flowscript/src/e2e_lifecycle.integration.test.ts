import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
const { Pool } = pg
import {
  claimQueuedRun,
  closeStore,
  createFlowTrigger,
  createRun,
  deleteFlowTrigger,
  deployFlow,
  enqueueDueSchedule,
  finishRun,
  getDeployedFlow,
  getRun,
  getStorePool,
  initializeStore,
  listFlowTriggers,
  listRuns,
  listStepAttempts,
  publishFlow,
  recordStepAttemptFinish,
  recordStepAttemptStart,
  rotateWebhookTriggerToken,
  setStorePool,
  updateFlowTrigger,
} from './store.js'
import {
  buildServer,
  signProjectId,
} from './server.js'
import { executeFlowIR } from './runtime.js'
import type { FlowIR } from './compiler.js'

const PG_URL = process.env.FLOWSCRIPT_POSTGRES_URL || process.env.POSTGRES_URL || 'postgres://postgres:postgres@localhost:5432/flowscript_test'
const IS_CI = process.env.CI === 'true'

describe('FlowScript E2E Lifecycle & Security Boundaries against PostgreSQL (issue #652)', () => {
  let testPool: pg.Pool | null = null
  let app: ReturnType<typeof buildServer>
  let pgAvailable = false

  beforeAll(async () => {
    // Attempt connecting to PostgreSQL
    try {
      const probePool = new Pool({
        connectionString: PG_URL,
        connectionTimeoutMillis: 3000,
      })
      await probePool.query('SELECT 1')
      testPool = probePool
      pgAvailable = true
    } catch (err) {
      if (IS_CI) {
        throw new Error(`[CI GATE FAILURE] PostgreSQL must be reachable in CI. Failed to connect to ${PG_URL}: ${(err as Error).message}`)
      } else {
        console.warn(`[SKIP LOCAL] PostgreSQL not reachable at ${PG_URL}. Skipping Postgres-backed tests. Set FLOWSCRIPT_POSTGRES_URL or run Docker Postgres to execute locally.`)
        return
      }
    }

    // Clean and initialize database
    await testPool.query(`
      DROP TABLE IF EXISTS flowscript_schedule_occurrences CASCADE;
      DROP TABLE IF EXISTS flowscript_step_attempts CASCADE;
      DROP TABLE IF EXISTS flowscript_idempotency_keys CASCADE;
      DROP TABLE IF EXISTS flowscript_triggers CASCADE;
      DROP TABLE IF EXISTS flowscript_runs CASCADE;
      DROP TABLE IF EXISTS flowscript_deployments CASCADE;
      DROP TABLE IF EXISTS flowscript_versions CASCADE;
    `)

    setStorePool(testPool)
    await initializeStore()
    app = buildServer()
  })

  afterAll(async () => {
    if (app) {
      await app.close()
    }
    if (testPool) {
      await closeStore()
    }
  })

  const testIfPg = () => (pgAvailable ? it : it.skip)

  describe('1. Full Lifecycle: Publish -> Deploy -> Run -> Worker Execution -> Inspection', () => {
    const projA = 'project_alpha_lifecycle'
    const flowName = 'order_processor'
    let versionId: string
    let runId: string

    testIfPg()('publishes a valid FlowScript flow and verifies immutable storage', async () => {
      const source = `flow: ${flowName}
version: 1
trigger:
  kind: manual
steps:
  - id: step_transform
    kind: transform
    config:
      value:
        orderId: "ORD-999"
        status: "confirmed"
        amount: 250
`
      const res = await app.inject({
        method: 'POST',
        url: '/v1/flows/publish',
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
        body: { source },
      })

      expect(res.statusCode).toBe(201)
      const data = res.json()
      expect(data.flowName).toBe(flowName)
      expect(data.version).toBe(1)
      expect(data.id).toBeDefined()
      versionId = data.id

      // Verify row exists directly in Postgres
      const dbRes = await testPool!.query(
        'SELECT id, project_id, flow_name, version, ir_hash FROM flowscript_versions WHERE id=$1',
        [versionId],
      )
      expect(dbRes.rowCount).toBe(1)
      expect(dbRes.rows[0].project_id).toBe(projA)
      expect(dbRes.rows[0].flow_name).toBe(flowName)
    })

    testIfPg()('deploys the published version to production environment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/flows/${flowName}/deploy`,
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
        body: {
          versionId,
          environment: 'production',
        },
      })

      expect(res.statusCode).toBe(200)
      const data = res.json()
      expect(data.flow_name).toBe(flowName)
      expect(data.status).toBe('active')

      // Verify active deployment in Postgres
      const deployed = await getDeployedFlow(projA, flowName, 'production')
      expect(deployed).not.toBeNull()
      expect(deployed!.id).toBe(versionId)
    })

    testIfPg()('enqueues a manual run and verifies queued status in database', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/flows/${flowName}/run`,
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
        body: {
          input: { customerId: 'CUST-123' },
          environment: 'production',
        },
      })

      expect(res.statusCode).toBe(202)
      const data = res.json()
      expect(data.status).toBe('queued')
      expect(data.runId).toBeDefined()
      runId = data.runId

      // Verify run status in Postgres
      const run = await getRun(projA, runId)
      expect(run).not.toBeNull()
      expect(run!.status).toBe('queued')
      expect(run!.workerId).toBeNull()
    })

    testIfPg()('worker claims queued run and executes to completion with attempt logging', async () => {
      const workerId = 'worker-e2e-node-1'
      const job = await claimQueuedRun(workerId, 30_000)
      expect(job).not.toBeNull()
      expect(job!.id).toBe(runId)
      expect(job!.project_id).toBe(projA)

      // Verify in-progress status in Postgres
      const inProgress = await getRun(projA, runId)
      expect(inProgress!.status).toBe('running')
      expect(inProgress!.workerId).toBe(workerId)
      expect(inProgress!.attemptCount).toBe(1)

      // Execute FlowIR
      const abortController = new AbortController()
      const result = await executeFlowIR(job!.ir as FlowIR, {
        input: job!.input,
        trigger: { kind: job!.trigger_kind, source: 'hosted-worker' },
        projectId: job!.project_id,
        runId: job!.id,
        signal: abortController.signal,
        onStepAttemptStart: async (stepId, attempt) => {
          return recordStepAttemptStart({ runId: job!.id, stepId, attempt })
        },
        onStepAttemptFinish: async (attemptId, details) => {
          if (typeof attemptId === 'string') {
            await recordStepAttemptFinish(attemptId, details)
          }
        },
      })

      expect(result.status).toBe('succeeded')

      // Finish run in Postgres
      await finishRun(job!.id, {
        status: 'succeeded',
        output: result.output,
        steps: result.steps,
      })

      // Inspect run via API
      const inspectRes = await app.inject({
        method: 'GET',
        url: `/v1/runs/${runId}`,
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
      })

      expect(inspectRes.statusCode).toBe(200)
      const inspectData = inspectRes.json()
      expect(inspectData.status).toBe('succeeded')
      expect(inspectData.finishedAt).not.toBeNull()

      // Inspect step attempts history via API
      const attemptsRes = await app.inject({
        method: 'GET',
        url: `/v1/runs/${runId}/attempts`,
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
      })

      expect(attemptsRes.statusCode).toBe(200)
      const attemptsData = attemptsRes.json()
      expect(attemptsData.attempts).toHaveLength(1)
      expect(attemptsData.attempts[0].stepId).toBe('step_transform')
      expect(attemptsData.attempts[0].status).toBe('succeeded')
    })
  })

  describe('2. Cross-Project Tenant Isolation Boundaries in PostgreSQL', () => {
    const projAlpha = 'proj_alpha_isolated'
    const projBeta = 'proj_beta_attacker'
    let versionAlphaId: string
    let runAlphaId: string

    testIfPg()('rejects cross-project version deployment', async () => {
      // Project Alpha publishes flow
      const pubRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/publish',
        headers: {
          'x-project-id': projAlpha,
          'x-project-signature': signProjectId(projAlpha),
        },
        body: {
          source: 'flow: secure_flow\nversion: 1\ntrigger:\n  kind: manual\nsteps:\n  - id: t1\n    kind: transform\n    config:\n      value: {}\n',
        },
      })
      expect(pubRes.statusCode).toBe(201)
      versionAlphaId = pubRes.json().id

      // Project Beta tries to deploy Project Alpha's version
      const deployRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/secure_flow/deploy',
        headers: {
          'x-project-id': projBeta,
          'x-project-signature': signProjectId(projBeta),
        },
        body: {
          versionId: versionAlphaId,
          environment: 'production',
        },
      })
      expect(deployRes.statusCode).toBe(404)
      expect(deployRes.json().code).toBe('VERSION_NOT_FOUND')
    })

    testIfPg()('prevents cross-project run inspection, listing, and cancellation', async () => {
      // Deploy flow in Alpha and enqueue run
      await deployFlow(projAlpha, 'secure_flow', versionAlphaId, 'production')
      const runRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/secure_flow/run',
        headers: {
          'x-project-id': projAlpha,
          'x-project-signature': signProjectId(projAlpha),
        },
        body: {},
      })
      expect(runRes.statusCode).toBe(202)
      runAlphaId = runRes.json().runId

      // Project Beta attempts to get Alpha's run -> 404
      const getRes = await app.inject({
        method: 'GET',
        url: `/v1/runs/${runAlphaId}`,
        headers: {
          'x-project-id': projBeta,
          'x-project-signature': signProjectId(projBeta),
        },
      })
      expect(getRes.statusCode).toBe(404)
      expect(getRes.json().code).toBe('RUN_NOT_FOUND')

      // Project Beta lists runs -> empty, Alpha run not leaked
      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/runs',
        headers: {
          'x-project-id': projBeta,
          'x-project-signature': signProjectId(projBeta),
        },
      })
      expect(listRes.statusCode).toBe(200)
      expect(listRes.json().runs).toHaveLength(0)

      // Project Beta attempts to cancel Alpha's run -> 404
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/v1/runs/${runAlphaId}/cancel`,
        headers: {
          'x-project-id': projBeta,
          'x-project-signature': signProjectId(projBeta),
        },
        body: { reason: 'malicious cancel' },
      })
      expect(cancelRes.statusCode).toBe(404)
      expect(cancelRes.json().code).toBe('RUN_NOT_FOUND')
    })

    testIfPg()('prevents cross-project trigger listing, patching, rotating, and deleting', async () => {
      // Create trigger in Alpha
      const trigRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/secure_flow/triggers',
        headers: {
          'x-project-id': projAlpha,
          'x-project-signature': signProjectId(projAlpha),
        },
        body: { kind: 'webhook', environment: 'production' },
      })
      expect(trigRes.statusCode).toBe(201)
      const trigId = trigRes.json().id

      // Project Beta lists triggers for secure_flow -> empty
      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/flows/secure_flow/triggers',
        headers: {
          'x-project-id': projBeta,
          'x-project-signature': signProjectId(projBeta),
        },
      })
      expect(listRes.statusCode).toBe(200)
      expect(listRes.json()).toHaveLength(0)

      // Project Beta attempts to patch Alpha trigger -> 404
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/v1/flows/secure_flow/triggers/${trigId}`,
        headers: {
          'x-project-id': projBeta,
          'x-project-signature': signProjectId(projBeta),
        },
        body: { enabled: false },
      })
      expect(patchRes.statusCode).toBe(404)
      expect(patchRes.json().code).toBe('TRIGGER_NOT_FOUND')

      // Project Beta attempts to rotate Alpha trigger -> 404
      const rotateRes = await app.inject({
        method: 'POST',
        url: `/v1/flows/secure_flow/triggers/${trigId}/rotate`,
        headers: {
          'x-project-id': projBeta,
          'x-project-signature': signProjectId(projBeta),
        },
      })
      expect(rotateRes.statusCode).toBe(404)
      expect(rotateRes.json().code).toBe('TRIGGER_NOT_FOUND')

      // Project Beta attempts to delete Alpha trigger -> 404
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/v1/flows/secure_flow/triggers/${trigId}`,
        headers: {
          'x-project-id': projBeta,
          'x-project-signature': signProjectId(projBeta),
        },
      })
      expect(deleteRes.statusCode).toBe(404)
      expect(deleteRes.json().code).toBe('TRIGGER_NOT_FOUND')
    })
  })

  describe('3. Worker Concurrency and Stale Lease Recovery in PostgreSQL', () => {
    const projWorker = 'proj_worker_concurrency'
    let workerFlowVersionId: string

    testIfPg()('FOR UPDATE SKIP LOCKED ensures exactly one concurrent worker claims a queued run', async () => {
      // Publish and deploy flow
      const pubRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/publish',
        headers: {
          'x-project-id': projWorker,
          'x-project-signature': signProjectId(projWorker),
        },
        body: {
          source: 'flow: concurrent_flow\nversion: 1\ntrigger:\n  kind: manual\nsteps:\n  - id: t1\n    kind: transform\n    config:\n      value: {}\n',
        },
      })
      workerFlowVersionId = pubRes.json().id
      await deployFlow(projWorker, 'concurrent_flow', workerFlowVersionId, 'production')

      // Enqueue a single run
      const runRes = await createRun({
        projectId: projWorker,
        flowName: 'concurrent_flow',
        environment: 'production',
        versionId: workerFlowVersionId,
        input: {},
        triggerKind: 'manual',
      })
      expect(runRes.id).toBeDefined()

      // Two workers simultaneously try to claim the queued job
      const [claim1, claim2] = await Promise.all([
        claimQueuedRun('worker-replica-A', 30_000),
        claimQueuedRun('worker-replica-B', 30_000),
      ])

      // Exactly one worker claimed it, the other received null
      const claimedCount = (claim1 !== null ? 1 : 0) + (claim2 !== null ? 1 : 0)
      expect(claimedCount).toBe(1)
      const winner = claim1 ?? claim2
      expect(winner!.id).toBe(runRes.id)

      // Clean up winner run
      await finishRun(winner!.id, { status: 'succeeded', steps: [] })
    })

    testIfPg()('recovers stale runs whose worker lease expired without completion', async () => {
      // Enqueue run and simulate crashed worker whose lease expired in the past
      const runRes = await createRun({
        projectId: projWorker,
        flowName: 'concurrent_flow',
        environment: 'production',
        versionId: workerFlowVersionId,
        input: {},
        triggerKind: 'manual',
      })

      // Simulate lease expiration by updating lease_expires_at to the past
      await testPool!.query(
        `UPDATE flowscript_runs
         SET status='running', worker_id='crashed-worker-99', lease_expires_at=now() - interval '10 seconds'
         WHERE id=$1`,
        [runRes.id],
      )

      // A healthy worker claims: the expired lease run must be claimed
      const recovered = await claimQueuedRun('healthy-worker-01', 30_000)
      expect(recovered).not.toBeNull()
      expect(recovered!.id).toBe(runRes.id)
      expect(recovered!.attempt_count).toBe(2)

      // Clean up
      await finishRun(recovered!.id, { status: 'succeeded', steps: [] })
    })
  })

  describe('4. Webhook Token Security & Ingress Deduplication in PostgreSQL', () => {
    const projWebhook = 'proj_webhook_e2e'
    let webhookFlowVersionId: string

    testIfPg()('hashes webhook token at rest and deduplicates deliveries with idempotency key', async () => {
      // Publish and deploy flow
      const pubRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/publish',
        headers: {
          'x-project-id': projWebhook,
          'x-project-signature': signProjectId(projWebhook),
        },
        body: {
          source: 'flow: hook_flow\nversion: 1\ntrigger:\n  kind: webhook\nsteps:\n  - id: t1\n    kind: transform\n    config:\n      value: {}\n',
        },
      })
      webhookFlowVersionId = pubRes.json().id
      await deployFlow(projWebhook, 'hook_flow', webhookFlowVersionId, 'production')

      // Create webhook trigger
      const triggerRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/hook_flow/triggers',
        headers: {
          'x-project-id': projWebhook,
          'x-project-signature': signProjectId(projWebhook),
        },
        body: { kind: 'webhook', environment: 'production' },
      })
      expect(triggerRes.statusCode).toBe(201)
      const { id: triggerId, token } = triggerRes.json()
      expect(token).toBeDefined()

      // Verify token is NOT stored in plaintext in PostgreSQL
      const dbTrigger = await testPool!.query(
        'SELECT secret_hash FROM flowscript_triggers WHERE id=$1',
        [triggerId],
      )
      expect(dbTrigger.rows[0].secret_hash).not.toBe(token)
      expect(dbTrigger.rows[0].secret_hash).toHaveLength(64) // SHA-256 hex length

      // First webhook delivery
      const eventKey = `evt-e2e-${randomUUID()}`
      const delivery1 = await app.inject({
        method: 'POST',
        url: `/v1/hooks/${token}`,
        headers: {
          'x-idempotency-key': eventKey,
        },
        body: { order: 'item-1', price: 99 },
      })
      expect(delivery1.statusCode).toBe(202)
      const firstRunId = delivery1.json().runId

      // Second webhook delivery with same idempotency key
      const delivery2 = await app.inject({
        method: 'POST',
        url: `/v1/hooks/${token}`,
        headers: {
          'x-idempotency-key': eventKey,
        },
        body: { order: 'item-1', price: 99 },
      })
      expect(delivery2.statusCode).toBe(200)
      expect(delivery2.headers['x-idempotent-replay']).toBe('true')
      expect(delivery2.json().runId).toBe(firstRunId)

      // Verify PostgreSQL has exactly ONE run recorded for this event
      const runRows = await testPool!.query(
        'SELECT id FROM flowscript_runs WHERE idempotency_key=$1',
        [eventKey],
      )
      expect(runRows.rowCount).toBe(1)
    })
  })

  describe('5. Schedule Deduplication and Concurrency in PostgreSQL', () => {
    const projSchedule = 'proj_schedule_e2e'
    let scheduleFlowVersionId: string

    testIfPg()('concurrent workers execute enqueueDueSchedule with atomic occurrence deduplication', async () => {
      // Publish and deploy flow
      const pubRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/publish',
        headers: {
          'x-project-id': projSchedule,
          'x-project-signature': signProjectId(projSchedule),
        },
        body: {
          source: 'flow: cron_flow\nversion: 1\ntrigger:\n  kind: schedule\nsteps:\n  - id: t1\n    kind: transform\n    config:\n      value: {}\n',
        },
      })
      scheduleFlowVersionId = pubRes.json().id
      await deployFlow(projSchedule, 'cron_flow', scheduleFlowVersionId, 'production')

      // Create schedule trigger
      const trig = await createFlowTrigger({
        projectId: projSchedule,
        flowName: 'cron_flow',
        environment: 'production',
        kind: 'schedule',
        config: { cron: '*/10 * * * *', timezone: 'UTC' },
      })

      // Simulate overdue trigger
      await testPool!.query(
        `UPDATE flowscript_triggers
         SET next_fire_at=now() - interval '2 minutes'
         WHERE id=$1`,
        [trig.id],
      )

      // Two workers poll due schedules at the exact same instant
      const [dispatchA, dispatchB] = await Promise.all([
        enqueueDueSchedule(),
        enqueueDueSchedule(),
      ])

      // Occurrence rows in flowscript_schedule_occurrences must be exactly 1
      const occRows = await testPool!.query(
        'SELECT * FROM flowscript_schedule_occurrences WHERE trigger_id=$1',
        [trig.id],
      )
      expect(occRows.rowCount).toBe(1)

      // Total enqueued runs for this trigger flow must be exactly 1
      const runRows = await testPool!.query(
        "SELECT id FROM flowscript_runs WHERE project_id=$1 AND flow_name='cron_flow' AND trigger_kind='schedule'",
        [projSchedule],
      )
      expect(runRows.rowCount).toBe(1)
    })
  })
})
