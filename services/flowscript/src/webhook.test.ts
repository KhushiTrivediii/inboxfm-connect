import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  createFlowTrigger,
  deleteFlowTrigger,
  enqueueWebhook,
  getStorePool,
  hashWebhookToken,
  listFlowTriggers,
  rotateWebhookTriggerToken,
  setStorePool,
  updateFlowTrigger,
} from './store.js'
import { buildServer, signProjectId } from './server.js'

describe('webhook token registration and ingress consistency (issue #655)', () => {
  let triggers: Map<string, any>
  let deployments: Map<string, any>
  let runs: Map<string, any>
  let idempotencies: Map<string, any>
  let mockPool: any
  let originalPool: any
  let app: ReturnType<typeof buildServer>

  beforeEach(() => {
    triggers = new Map()
    deployments = new Map()
    runs = new Map()
    idempotencies = new Map()
    originalPool = getStorePool()
    app = buildServer()

    // Create an in-memory client/pool simulating Postgres with transactional support
    const executeQuery = async (sql: string, params: any[] = []) => {
      const trimmed = sql.trim()

      if (trimmed.startsWith('SELECT v.id, v.ir, d.flow_name, d.environment') || trimmed.includes('FROM flowscript_deployments')) {
        const [projectId, flowName, env] = params
        for (const dep of deployments.values()) {
          if (dep.project_id === projectId && dep.flow_name === flowName && dep.environment === env && dep.status === 'active') {
            return { rows: [{ id: dep.version_id, version_id: dep.version_id, flow_name: dep.flow_name, environment: dep.environment }], rowCount: 1 }
          }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('FROM flowscript_triggers WHERE kind=\'webhook\' AND enabled=true AND secret_hash=$1')) {
        const [secretHash] = params
        for (const tr of triggers.values()) {
          if (tr.kind === 'webhook' && tr.enabled && tr.secret_hash === secretHash) {
            return { rows: [{ id: tr.id, project_id: tr.project_id, flow_name: tr.flow_name, environment: tr.environment }], rowCount: 1 }
          }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('FROM flowscript_webhook_idempotency WHERE trigger_id=$1 AND idempotency_key=$2')) {
        const [triggerId, key] = params
        const composite = `${triggerId}:${key}`
        const existing = idempotencies.get(composite)
        if (existing) {
          return { rows: [{ run_id: existing.run_id }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('INSERT INTO flowscript_webhook_idempotency')) {
        const [, triggerId, key, runId] = params
        const composite = `${triggerId}:${key}`
        if (idempotencies.has(composite)) {
          // ON CONFLICT DO NOTHING returns 0 rows
          return { rows: [], rowCount: 0 }
        }
        idempotencies.set(composite, { trigger_id: triggerId, idempotency_key: key, run_id: runId })
        return { rows: [{ run_id: runId }], rowCount: 1 }
      }

      if (trimmed.includes('INSERT INTO flowscript_runs')) {
        const [runId, projectId, flowName, env, versionId, , input] = params
        runs.set(runId, { id: runId, project_id: projectId, flow_name: flowName, environment: env, version_id: versionId, input })
        return { rows: [{ id: runId }], rowCount: 1 }
      }

      if (trimmed.includes('INSERT INTO flowscript_triggers')) {
        const [id, projectId, flowName, env, kind, config, secretHash] = params
        triggers.set(id, { id, project_id: projectId, flow_name: flowName, environment: env, kind, config, secret_hash: secretHash, enabled: true, created_at: new Date() })
        return { rows: [{ id }], rowCount: 1 }
      }

      if (trimmed.includes('FROM flowscript_triggers WHERE project_id=$1 AND flow_name=$2')) {
        const [projectId, flowName] = params
        const rows = []
        for (const tr of triggers.values()) {
          if (tr.project_id === projectId && tr.flow_name === flowName) {
            rows.push(tr)
          }
        }
        return { rows, rowCount: rows.length }
      }

      if (trimmed.includes('UPDATE flowscript_triggers SET enabled=$4 WHERE id=$1 AND project_id=$2 AND flow_name=$3')) {
        const [id, projectId, flowName, enabled] = params
        const tr = triggers.get(id)
        if (tr && tr.project_id === projectId && tr.flow_name === flowName) {
          tr.enabled = enabled
          return { rows: [{ id: tr.id, flow_name: tr.flow_name, enabled: tr.enabled }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('DELETE FROM flowscript_triggers WHERE id=$1 AND project_id=$2 AND flow_name=$3')) {
        const [id, projectId, flowName] = params
        const tr = triggers.get(id)
        if (tr && tr.project_id === projectId && tr.flow_name === flowName) {
          triggers.delete(id)
          return { rowCount: 1 }
        }
        return { rowCount: 0 }
      }

      if (trimmed.includes('UPDATE flowscript_triggers') && trimmed.includes('SET secret_hash=$4')) {
        const [id, projectId, flowName, secretHash] = params
        const tr = triggers.get(id)
        if (tr && tr.project_id === projectId && tr.flow_name === flowName && tr.kind === 'webhook') {
          tr.secret_hash = secretHash
          return { rows: [{ id: tr.id, flow_name: tr.flow_name }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      return { rows: [], rowCount: 0 }
    }

    mockPool = {
      query: executeQuery,
      connect: async () => ({
        query: executeQuery,
        release: () => {},
      }),
      end: async () => {},
    }

    setStorePool(mockPool)
  })

  afterEach(() => {
    setStorePool(originalPool)
  })

  it('hashWebhookToken derives a consistent deterministic SHA-256 hex digest', () => {
    const token = 'test-token-1234567890abcdefghijklmnopqrstuvwxyz'
    const hash = hashWebhookToken(token)
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(hash).toHaveLength(64)
  })

  it('createFlowTrigger generates high-entropy token, stores only SHA-256 hash, and returns token once', async () => {
    deployments.set('dep-1', {
      project_id: 'proj_alpha',
      flow_name: 'contact-form',
      environment: 'production',
      version_id: 'ver-1',
      status: 'active',
    })

    const trigger = await createFlowTrigger({
      projectId: 'proj_alpha',
      flowName: 'contact-form',
      environment: 'production',
      kind: 'webhook',
      config: { sampleProp: 1 },
    })

    expect(trigger.id).toBeDefined()
    expect(trigger.token).toBeDefined()
    expect(trigger.token?.length).toBeGreaterThanOrEqual(40)
    expect(trigger.enabled).toBe(true)

    // Verify stored entity
    const stored = triggers.get(trigger.id)
    expect(stored).toBeDefined()
    expect(stored.secret_hash).toBe(hashWebhookToken(trigger.token!))
    // Raw token must NEVER be persisted in database
    expect(stored.token).toBeUndefined()
  })

  it('enqueueWebhook accepts a valid token and enqueues a run with payload', async () => {
    deployments.set('dep-1', {
      project_id: 'proj_alpha',
      flow_name: 'contact-form',
      environment: 'production',
      version_id: 'ver-1',
      status: 'active',
    })

    const token = randomBytes(32).toString('base64url')
    triggers.set('tr-1', {
      id: 'tr-1',
      project_id: 'proj_alpha',
      flow_name: 'contact-form',
      environment: 'production',
      kind: 'webhook',
      secret_hash: hashWebhookToken(token),
      enabled: true,
    })

    const result = await enqueueWebhook(token, { sender: 'test@example.com', text: 'Hello' })
    expect(result).not.toBeNull()
    expect(result?.runId).toBeDefined()
    expect(result?.duplicate).toBe(false)
    expect(runs.has(result!.runId)).toBe(true)
  })

  it('returns generic 404 for nonexistent, invalid, or forged tokens', async () => {
    const invalidResult = await enqueueWebhook('completely-unknown-token-1234567890abcdef', { a: 1 })
    expect(invalidResult).toBeNull()

    // Test HTTP endpoint returns generic 404
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hooks/completely-unknown-token-1234567890abcdef',
      payload: { a: 1 },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Webhook endpoint not found')
  })

  it('returns generic 404 for disabled or revoked triggers without disclosing trigger existence', async () => {
    deployments.set('dep-1', {
      project_id: 'proj_alpha',
      flow_name: 'contact-form',
      environment: 'production',
      version_id: 'ver-1',
      status: 'active',
    })

    const token = randomBytes(32).toString('base64url')
    triggers.set('tr-revoked', {
      id: 'tr-revoked',
      project_id: 'proj_alpha',
      flow_name: 'contact-form',
      environment: 'production',
      kind: 'webhook',
      secret_hash: hashWebhookToken(token),
      enabled: false, // Disabled/revoked
    })

    const res = await app.inject({
      method: 'POST',
      url: `/v1/hooks/${token}`,
      payload: { event: 'ping' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Webhook endpoint not found')
  })

  it('returns generic 404 if active deployment does not exist for the trigger flow', async () => {
    const token = randomBytes(32).toString('base64url')
    triggers.set('tr-no-dep', {
      id: 'tr-no-dep',
      project_id: 'proj_alpha',
      flow_name: 'unreleased-flow',
      environment: 'production',
      kind: 'webhook',
      secret_hash: hashWebhookToken(token),
      enabled: true,
    })

    const res = await app.inject({
      method: 'POST',
      url: `/v1/hooks/${token}`,
      payload: { event: 'ping' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Webhook endpoint not found')
  })

  it('rejects malformed or non-object webhook payloads with 400', async () => {
    const token = randomBytes(32).toString('base64url')

    // Array payload rejected
    const arrayRes = await app.inject({
      method: 'POST',
      url: `/v1/hooks/${token}`,
      headers: { 'content-type': 'application/json' },
      payload: '[1, 2, 3]',
    })
    expect(arrayRes.statusCode).toBe(400)
    expect(arrayRes.json().error).toContain('Invalid webhook payload')

    // String payload rejected
    const stringRes = await app.inject({
      method: 'POST',
      url: `/v1/hooks/${token}`,
      headers: { 'content-type': 'application/json' },
      payload: '"just a string"',
    })
    expect(stringRes.statusCode).toBe(400)
    expect(stringRes.json().error).toContain('Invalid webhook payload')
  })

  it('rejects tokens that are too short (< 32 chars) with 404', async () => {
    const shortRes = await app.inject({
      method: 'POST',
      url: '/v1/hooks/short-token',
      payload: { a: 1 },
    })
    expect(shortRes.statusCode).toBe(404)
    expect(shortRes.json().error).toBe('Webhook endpoint not found')
  })

  it('durable idempotency contract: prevents duplicate enqueueing on duplicate deliveries', async () => {
    deployments.set('dep-1', {
      project_id: 'proj_alpha',
      flow_name: 'order-processed',
      environment: 'production',
      version_id: 'ver-1',
      status: 'active',
    })

    const token = randomBytes(32).toString('base64url')
    triggers.set('tr-orders', {
      id: 'tr-orders',
      project_id: 'proj_alpha',
      flow_name: 'order-processed',
      environment: 'production',
      kind: 'webhook',
      secret_hash: hashWebhookToken(token),
      enabled: true,
    })

    // 1. First delivery with x-idempotency-key
    const res1 = await app.inject({
      method: 'POST',
      url: `/v1/hooks/${token}`,
      headers: { 'x-idempotency-key': 'evt_order_1001' },
      payload: { orderId: '1001', amount: 50 },
    })
    expect(res1.statusCode).toBe(202)
    const body1 = res1.json()
    expect(body1.accepted).toBe(true)
    expect(body1.status).toBe('queued')
    const firstRunId = body1.runId
    expect(runs.size).toBe(1)

    // 2. Second delivery with the SAME idempotency key returns duplicate status with identical runId
    const res2 = await app.inject({
      method: 'POST',
      url: `/v1/hooks/${token}`,
      headers: { 'x-idempotency-key': 'evt_order_1001' },
      payload: { orderId: '1001', amount: 50 },
    })
    expect(res2.statusCode).toBe(200)
    expect(res2.headers['x-idempotent-replay']).toBe('true')
    const body2 = res2.json()
    expect(body2.accepted).toBe(true)
    expect(body2.runId).toBe(firstRunId)
    expect(body2.status).toBe('duplicate')

    // No duplicate run was created in durable store!
    expect(runs.size).toBe(1)
  })

  it('durable idempotency contract: supports payload event_id field', async () => {
    deployments.set('dep-1', {
      project_id: 'proj_alpha',
      flow_name: 'stripe-events',
      environment: 'production',
      version_id: 'ver-1',
      status: 'active',
    })

    const token = randomBytes(32).toString('base64url')
    triggers.set('tr-stripe', {
      id: 'tr-stripe',
      project_id: 'proj_alpha',
      flow_name: 'stripe-events',
      environment: 'production',
      kind: 'webhook',
      secret_hash: hashWebhookToken(token),
      enabled: true,
    })

    // Delivery 1 with event_id inside body
    const res1 = await app.inject({
      method: 'POST',
      url: `/v1/hooks/${token}`,
      payload: { event_id: 'evt_stripe_payment_99', charge: 9900 },
    })
    expect(res1.statusCode).toBe(202)
    const runId1 = res1.json().runId

    // Delivery 2 with identical event_id inside body
    const res2 = await app.inject({
      method: 'POST',
      url: `/v1/hooks/${token}`,
      payload: { event_id: 'evt_stripe_payment_99', charge: 9900 },
    })
    expect(res2.statusCode).toBe(200)
    expect(res2.headers['x-idempotent-replay']).toBe('true')
    expect(res2.json().runId).toBe(runId1)
    expect(runs.size).toBe(1)
  })

  it('trigger lifecycle: listFlowTriggers never discloses secret_hash', async () => {
    triggers.set('tr-1', {
      id: 'tr-1',
      project_id: 'proj_alpha',
      flow_name: 'order-processed',
      environment: 'production',
      kind: 'webhook',
      config: { webhook: true },
      secret_hash: 'secret_hash_not_for_export',
      enabled: true,
      created_at: new Date(),
    })

    const list = await listFlowTriggers('proj_alpha', 'order-processed')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('tr-1')
    expect((list[0] as any).secret_hash).toBeUndefined()
  })

  it('trigger lifecycle: updateFlowTrigger toggles enabled status', async () => {
    triggers.set('tr-1', {
      id: 'tr-1',
      project_id: 'proj_alpha',
      flow_name: 'order-processed',
      environment: 'production',
      kind: 'webhook',
      enabled: true,
    })

    const updated = await updateFlowTrigger('proj_alpha', 'order-processed', 'tr-1', { enabled: false })
    expect(updated).not.toBeNull()
    expect(updated?.enabled).toBe(false)
    expect(triggers.get('tr-1').enabled).toBe(false)
  })

  it('trigger lifecycle: rotateWebhookTriggerToken generates a new token and revokes old one', async () => {
    const oldToken = 'old-token-12345678901234567890123456789012'
    triggers.set('tr-rotate', {
      id: 'tr-rotate',
      project_id: 'proj_alpha',
      flow_name: 'order-processed',
      environment: 'production',
      kind: 'webhook',
      secret_hash: hashWebhookToken(oldToken),
      enabled: true,
    })

    const rotated = await rotateWebhookTriggerToken('proj_alpha', 'order-processed', 'tr-rotate')
    expect(rotated).not.toBeNull()
    expect(rotated?.token).toBeDefined()
    expect(rotated?.token).not.toBe(oldToken)

    // Stored hash is updated to new token hash
    const stored = triggers.get('tr-rotate')
    expect(stored.secret_hash).toBe(hashWebhookToken(rotated!.token))

    // Old token lookup fails
    const oldLookup = await enqueueWebhook(oldToken, { event: 1 })
    expect(oldLookup).toBeNull()

    // New token lookup succeeds
    deployments.set('dep-1', {
      project_id: 'proj_alpha',
      flow_name: 'order-processed',
      environment: 'production',
      version_id: 'ver-1',
      status: 'active',
    })
    const newLookup = await enqueueWebhook(rotated!.token, { event: 1 })
    expect(newLookup).not.toBeNull()
  })

  it('trigger lifecycle: deleteFlowTrigger permanently removes the trigger', async () => {
    triggers.set('tr-del', {
      id: 'tr-del',
      project_id: 'proj_alpha',
      flow_name: 'order-processed',
      environment: 'production',
      kind: 'webhook',
      enabled: true,
    })

    const deleted = await deleteFlowTrigger('proj_alpha', 'order-processed', 'tr-del')
    expect(deleted).toBe(true)
    expect(triggers.has('tr-del')).toBe(false)

    // Second delete returns false
    const deletedAgain = await deleteFlowTrigger('proj_alpha', 'order-processed', 'tr-del')
    expect(deletedAgain).toBe(false)
  })

  it('trigger management routes: list, patch, delete, and rotate require gateway signature', async () => {
    const secret = 'gateway_test_secret'
    process.env.FLOWSCRIPT_GATEWAY_SECRET = secret
    const triggerId = '00000000-0000-0000-0000-000000000001'

    try {
      // 1. Unsigned request rejected with 401
      const unsigned = await app.inject({
        method: 'GET',
        url: '/v1/flows/my-flow/triggers',
        headers: { 'x-project-id': 'proj_auth_test' },
      })
      expect(unsigned.statusCode).toBe(401)

      // 2. Signed request succeeds
      const sig = signProjectId('proj_auth_test', secret)
      const signed = await app.inject({
        method: 'GET',
        url: '/v1/flows/my-flow/triggers',
        headers: { 'x-project-id': 'proj_auth_test', 'x-project-signature': sig },
      })
      expect(signed.statusCode).toBe(200)
      expect(Array.isArray(signed.json())).toBe(true)

      // 3. Patch route requires signature
      const patchUnsigned = await app.inject({
        method: 'PATCH',
        url: `/v1/flows/my-flow/triggers/${triggerId}`,
        headers: { 'x-project-id': 'proj_auth_test' },
        payload: { enabled: false },
      })
      expect(patchUnsigned.statusCode).toBe(401)

      // 4. Delete route requires signature
      const deleteUnsigned = await app.inject({
        method: 'DELETE',
        url: `/v1/flows/my-flow/triggers/${triggerId}`,
        headers: { 'x-project-id': 'proj_auth_test' },
      })
      expect(deleteUnsigned.statusCode).toBe(401)

      // 5. Rotate route requires signature
      const rotateUnsigned = await app.inject({
        method: 'POST',
        url: `/v1/flows/my-flow/triggers/${triggerId}/rotate`,
        headers: { 'x-project-id': 'proj_auth_test' },
      })
      expect(rotateUnsigned.statusCode).toBe(401)
    } finally {
      delete process.env.FLOWSCRIPT_GATEWAY_SECRET
    }
  })
})
