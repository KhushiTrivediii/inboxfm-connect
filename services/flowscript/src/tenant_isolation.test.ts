import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  createFlowTrigger,
  createRun,
  deleteFlowTrigger,
  deployFlow,
  getDeployedFlow,
  getRun,
  getStorePool,
  listFlowTriggers,
  listRuns,
  publishFlow,
  rotateWebhookTriggerToken,
  setStorePool,
  updateFlowTrigger,
} from './store.js'
import {
  buildServer,
  generateProjectToken,
  getGatewaySecret,
  signProjectId,
  stripUntrustedProjectHeaders,
  verifyProjectIdentity,
} from './server.js'

describe('FlowScript tenant isolation and API boundaries (issue #651)', () => {
  let versions: Map<string, any>
  let deployments: Map<string, any>
  let runs: Map<string, any>
  let triggers: Map<string, any>
  let mockPool: any
  let originalPool: any
  let app: ReturnType<typeof buildServer>

  beforeEach(() => {
    versions = new Map()
    deployments = new Map()
    runs = new Map()
    triggers = new Map()
    originalPool = getStorePool()
    app = buildServer()

    const executeQuery = async (sql: string, params: any[] = []) => {
      const trimmed = sql.trim()

      if (trimmed.startsWith('SELECT COALESCE(MAX(version)')) {
        const [projectId, flowName] = params
        let maxV = 0
        for (const v of versions.values()) {
          if (v.project_id === projectId && v.flow_name === flowName) {
            maxV = Math.max(maxV, v.version)
          }
        }
        return { rows: [{ version: maxV }], rowCount: 1 }
      }

      if (trimmed.startsWith('INSERT INTO flowscript_versions')) {
        const [id, projectId, flowName, version, source, ir, hash] = params
        const record = { id, project_id: projectId, flow_name: flowName, version, source_text: source, ir: JSON.parse(ir), ir_hash: hash }
        versions.set(id, record)
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.startsWith('SELECT flow_name FROM flowscript_versions WHERE id=$1 AND project_id=$2')) {
        const [versionId, projectId] = params
        const v = versions.get(versionId)
        if (v && v.project_id === projectId) {
          return { rows: [{ flow_name: v.flow_name }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.startsWith('INSERT INTO flowscript_deployments')) {
        const [id, projectId, flowName, env, versionId] = params
        const key = `${projectId}:${flowName}:${env}`
        deployments.set(key, { id, project_id: projectId, flow_name: flowName, environment: env, version_id: versionId, status: 'active' })
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('FROM flowscript_deployments d JOIN flowscript_versions v')) {
        const [projectId, flowName, env] = params
        const key = `${projectId}:${flowName}:${env}`
        const dep = deployments.get(key)
        if (dep && dep.status === 'active') {
          const v = versions.get(dep.version_id)
          return { rows: [{ id: v.id, ir: v.ir, flow_name: dep.flow_name, environment: dep.environment }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.startsWith('INSERT INTO flowscript_runs')) {
        const [id, projectId, flowName, env, versionId, triggerKind, input] = params
        const record = { id, project_id: projectId, flow_name: flowName, environment: env, version_id: versionId, trigger_kind: triggerKind, status: 'queued', input }
        runs.set(id, record)
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

      if (trimmed.startsWith('SELECT * FROM flowscript_runs WHERE project_id=$1')) {
        const [projectId] = params
        const results = Array.from(runs.values()).filter(r => r.project_id === projectId)
        return { rows: results, rowCount: results.length }
      }

      if (trimmed.startsWith('INSERT INTO flowscript_triggers')) {
        const [id, projectId, flowName, env, kind, config, secretHash] = params
        const record = { id, project_id: projectId, flow_name: flowName, environment: env, kind, config, secret_hash: secretHash, enabled: true }
        triggers.set(id, record)
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.startsWith('SELECT id, flow_name, environment, kind, config, enabled, next_fire_at, last_fired_at, created_at FROM flowscript_triggers WHERE project_id=$1 AND flow_name=$2')) {
        const [projectId, flowName] = params
        const matches = Array.from(triggers.values()).filter(t => t.project_id === projectId && t.flow_name === flowName)
        return { rows: matches, rowCount: matches.length }
      }

      if (trimmed.startsWith('UPDATE flowscript_triggers SET enabled=$4 WHERE id=$1 AND project_id=$2 AND flow_name=$3')) {
        const [id, projectId, flowName, enabled] = params
        const t = triggers.get(id)
        if (t && t.project_id === projectId && t.flow_name === flowName) {
          t.enabled = enabled
          return { rows: [{ id: t.id, flow_name: t.flow_name, enabled: t.enabled }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.startsWith('DELETE FROM flowscript_triggers WHERE id=$1 AND project_id=$2 AND flow_name=$3')) {
        const [id, projectId, flowName] = params
        const t = triggers.get(id)
        if (t && t.project_id === projectId && t.flow_name === flowName) {
          triggers.delete(id)
          return { rowCount: 1 }
        }
        return { rowCount: 0 }
      }

      if (trimmed.startsWith('UPDATE flowscript_triggers SET secret_hash=$4 WHERE id=$1 AND project_id=$2 AND flow_name=$3')) {
        const [id, projectId, flowName, secretHash] = params
        const t = triggers.get(id)
        if (t && t.project_id === projectId && t.flow_name === flowName) {
          t.secret_hash = secretHash
          return { rows: [{ id: t.id, flow_name: t.flow_name }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
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

  describe('Unauthenticated and forged request rejection', () => {
    it('rejects unauthenticated requests to project-scoped endpoints with 401', async () => {
      const endpoints = [
        { method: 'POST', url: '/v1/flows/publish', body: { source: 'flow test { transform t1 { return {} } }' } },
        { method: 'POST', url: '/v1/flows/my-flow/deploy', body: { versionId: randomUUID() } },
        { method: 'POST', url: '/v1/flows/my-flow/run', body: {} },
        { method: 'GET', url: '/v1/runs' },
        { method: 'GET', url: `/v1/runs/${randomUUID()}` },
        { method: 'POST', url: '/v1/flows/my-flow/triggers', body: { kind: 'schedule', cron: '* * * * *' } },
        { method: 'GET', url: '/v1/flows/my-flow/triggers' },
        { method: 'PATCH', url: `/v1/flows/my-flow/triggers/${randomUUID()}`, body: { enabled: false } },
        { method: 'DELETE', url: `/v1/flows/my-flow/triggers/${randomUUID()}` },
        { method: 'POST', url: `/v1/flows/my-flow/triggers/${randomUUID()}/rotate` },
      ]

      for (const endpoint of endpoints) {
        const res = await app.inject({
          method: endpoint.method as any,
          url: endpoint.url,
          body: endpoint.body,
        })

        expect(res.statusCode).toBe(401)
        const json = res.json()
        expect(json.code).toBeDefined()
        expect(json.statusCode).toBe(401)
        expect(json.error).toBeDefined()
        expect(json.requestId).toBeDefined()
      }
    })

    it('rejects forged x-project-id without valid cryptographic gateway signature with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/run',
        headers: {
          'x-project-id': 'victim_project_123',
        },
        body: {},
      })

      expect(res.statusCode).toBe(401)
      const json = res.json()
      expect(json.code).toBe('UNVERIFIED_PROJECT_IDENTITY')
      expect(json.error).toContain('cryptographic signature is required')
    })

    it('rejects forged x-project-signature with invalid HMAC signature with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/run',
        headers: {
          'x-project-id': 'victim_project_123',
          'x-project-signature': '0000000000000000000000000000000000000000000000000000000000000000',
        },
        body: {},
      })

      expect(res.statusCode).toBe(401)
      const json = res.json()
      expect(json.code).toBe('INVALID_PROJECT_SIGNATURE')
      expect(json.error).toContain('Invalid project identity signature')
    })

    it('rejects identity conflict when Bearer token project does not match x-project-id header', async () => {
      const token = generateProjectToken('real_project_owner')

      const res = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/run',
        headers: {
          authorization: `Bearer ${token}`,
          'x-project-id': 'victim_project_target',
        },
        body: {},
      })

      expect(res.statusCode).toBe(401)
      const json = res.json()
      expect(json.code).toBe('FORGED_PROJECT_HEADER')
      expect(json.error).toContain('does not match authenticated bearer token')
    })

    it('fails closed when gateway secret is missing', async () => {
      const check = verifyProjectIdentity({ headers: { 'x-project-id': 'p1' } }, '')
      expect(check.valid).toBe(false)
      expect(check.code).toBe('GATEWAY_SECRET_MISSING')
      expect(check.projectId).toBeNull()
    })

    it('strips untrusted project headers via stripUntrustedProjectHeaders helper', () => {
      const headers: Record<string, unknown> = {
        'content-type': 'application/json',
        'x-project-id': 'forged_project',
        'x-project-signature': 'forged_sig',
        'x-gateway-signature': 'forged_gw',
        'authorization': 'Bearer user_token',
      }
      stripUntrustedProjectHeaders(headers)
      expect(headers['x-project-id']).toBeUndefined()
      expect(headers['x-project-signature']).toBeUndefined()
      expect(headers['x-gateway-signature']).toBeUndefined()
      expect(headers['content-type']).toBe('application/json')
    })
  })

  describe('Cross-project deployment and flow name mismatch isolation', () => {
    it('rejects cross-project version deployment with 404 VERSION_NOT_FOUND', async () => {
      const projA = 'project_alpha'
      const projB = 'project_beta'

      // Project A publishes flow
      const pubRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/publish',
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
        body: {
          source: 'flow: alpha_flow\nversion: 1\ntrigger:\n  kind: manual\nsteps:\n  - id: t1\n    kind: transform\n    config:\n      value:\n        ok: true\n',
        },
      })
      expect(pubRes.statusCode).toBe(201)
      const versionId = pubRes.json().id

      // Project B attempts to deploy Project A's published versionId
      const deployRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/alpha_flow/deploy',
        headers: {
          'x-project-id': projB,
          'x-project-signature': signProjectId(projB),
        },
        body: {
          versionId,
          environment: 'production',
        },
      })

      expect(deployRes.statusCode).toBe(404)
      const json = deployRes.json()
      expect(json.code).toBe('VERSION_NOT_FOUND')
      expect(json.error).toContain('not found in this project')
    })

    it('rejects deployment when URL flow name does not match the version flow name with 400 FLOW_NAME_MISMATCH', async () => {
      const proj = 'project_gamma'

      const pubRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/publish',
        headers: {
          'x-project-id': proj,
          'x-project-signature': signProjectId(proj),
        },
        body: {
          source: 'flow: correct_name\nversion: 1\ntrigger:\n  kind: manual\nsteps:\n  - id: t1\n    kind: transform\n    config:\n      value: {}\n',
        },
      })
      expect(pubRes.statusCode).toBe(201)
      const versionId = pubRes.json().id

      // Deploy with mismatched URL :name
      const deployRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/mismatched_name/deploy',
        headers: {
          'x-project-id': proj,
          'x-project-signature': signProjectId(proj),
        },
        body: {
          versionId,
        },
      })

      expect(deployRes.statusCode).toBe(400)
      const json = deployRes.json()
      expect(json.code).toBe('FLOW_NAME_MISMATCH')
      expect(json.error).toContain('belongs to flow "correct_name", not "mismatched_name"')
    })
  })

  describe('Cross-project run and trigger resource isolation', () => {
    it('ensures runs from Project A cannot be read or listed by Project B', async () => {
      const projA = 'project_runs_a'
      const projB = 'project_runs_b'

      // Deploy and enqueue run in Project A
      const vId = randomUUID()
      versions.set(vId, {
        id: vId,
        project_id: projA,
        flow_name: 'test_flow',
        version: 1,
        ir: { irVersion: 1, name: 'test_flow', version: 1, trigger: { kind: 'manual' }, steps: [] },
      })
      deployments.set(`${projA}:test_flow:production`, {
        id: randomUUID(),
        project_id: projA,
        flow_name: 'test_flow',
        environment: 'production',
        version_id: vId,
        status: 'active',
      })

      const runResA = await app.inject({
        method: 'POST',
        url: '/v1/flows/test_flow/run',
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
        body: {},
      })
      expect(runResA.statusCode).toBe(202)
      const runIdA = runResA.json().runId

      // Project B lists runs -> empty list, runIdA is not leaked
      const listResB = await app.inject({
        method: 'GET',
        url: '/v1/runs',
        headers: {
          'x-project-id': projB,
          'x-project-signature': signProjectId(projB),
        },
      })
      expect(listResB.statusCode).toBe(200)
      expect(listResB.json().runs).toHaveLength(0)

      // Project B attempts to fetch Project A's run by ID -> 404 RUN_NOT_FOUND
      const getResB = await app.inject({
        method: 'GET',
        url: `/v1/runs/${runIdA}`,
        headers: {
          'x-project-id': projB,
          'x-project-signature': signProjectId(projB),
        },
      })
      expect(getResB.statusCode).toBe(404)
      expect(getResB.json().code).toBe('RUN_NOT_FOUND')

      // Project A fetches its own run -> 200
      const getResA = await app.inject({
        method: 'GET',
        url: `/v1/runs/${runIdA}`,
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
      })
      expect(getResA.statusCode).toBe(200)
      expect(getResA.json().id).toBe(runIdA)
    })

    it('ensures triggers configured in Project A cannot be read, patched, or deleted by Project B', async () => {
      const projA = 'project_trig_a'
      const projB = 'project_trig_b'

      // Ensure alert_flow has an active deployment in Project A
      const vId = randomUUID()
      versions.set(vId, {
        id: vId,
        project_id: projA,
        flow_name: 'alert_flow',
        version: 1,
        ir: { irVersion: 1, name: 'alert_flow', version: 1, trigger: { kind: 'webhook' }, steps: [] },
      })
      deployments.set(`${projA}:alert_flow:production`, {
        id: randomUUID(),
        project_id: projA,
        flow_name: 'alert_flow',
        environment: 'production',
        version_id: vId,
        status: 'active',
      })

      // Create webhook trigger in Project A
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/alert_flow/triggers',
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
        body: {
          kind: 'webhook',
          environment: 'production',
        },
      })
      expect(createRes.statusCode).toBe(201)
      const trigId = createRes.json().id

      // Project B lists triggers for alert_flow -> empty list
      const listResB = await app.inject({
        method: 'GET',
        url: '/v1/flows/alert_flow/triggers',
        headers: {
          'x-project-id': projB,
          'x-project-signature': signProjectId(projB),
        },
      })
      expect(listResB.statusCode).toBe(200)
      expect(listResB.json()).toHaveLength(0)

      // Project B attempts to patch Project A's trigger -> 404
      const patchResB = await app.inject({
        method: 'PATCH',
        url: `/v1/flows/alert_flow/triggers/${trigId}`,
        headers: {
          'x-project-id': projB,
          'x-project-signature': signProjectId(projB),
        },
        body: { enabled: false },
      })
      expect(patchResB.statusCode).toBe(404)
      expect(patchResB.json().code).toBe('TRIGGER_NOT_FOUND')

      // Project B attempts to rotate Project A's trigger -> 404
      const rotateResB = await app.inject({
        method: 'POST',
        url: `/v1/flows/alert_flow/triggers/${trigId}/rotate`,
        headers: {
          'x-project-id': projB,
          'x-project-signature': signProjectId(projB),
        },
      })
      expect(rotateResB.statusCode).toBe(404)
      expect(rotateResB.json().code).toBe('TRIGGER_NOT_FOUND')

      // Project B attempts to delete Project A's trigger -> 404
      const deleteResB = await app.inject({
        method: 'DELETE',
        url: `/v1/flows/alert_flow/triggers/${trigId}`,
        headers: {
          'x-project-id': projB,
          'x-project-signature': signProjectId(projB),
        },
      })
      expect(deleteResB.statusCode).toBe(404)
      expect(deleteResB.json().code).toBe('TRIGGER_NOT_FOUND')

      // Project A still has its trigger intact
      const listResA = await app.inject({
        method: 'GET',
        url: '/v1/flows/alert_flow/triggers',
        headers: {
          'x-project-id': projA,
          'x-project-signature': signProjectId(projA),
        },
      })
      expect(listResA.statusCode).toBe(200)
      expect(listResA.json()).toHaveLength(1)
      expect(listResA.json()[0].id).toBe(trigId)
    })
  })

  describe('Request IDs, error envelopes, and payload limits', () => {
    it('echoes caller x-request-id in response header and error envelope', async () => {
      const customReqId = 'custom-trace-id-12345'
      const res = await app.inject({
        method: 'GET',
        url: '/v1/runs',
        headers: {
          'x-request-id': customReqId,
        },
      })

      expect(res.headers['x-request-id']).toBe(customReqId)
      const json = res.json()
      expect(json.requestId).toBe(customReqId)
      expect(json.statusCode).toBe(401)
    })

    it('generates a UUID request ID when caller does not provide x-request-id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/runs',
      })

      const generatedId = res.headers['x-request-id'] as string
      expect(generatedId).toBeDefined()
      expect(generatedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      expect(res.json().requestId).toBe(generatedId)
    })

    it('rejects oversized request bodies exceeding bodyLimit (1MB) with 413 PAYLOAD_TOO_LARGE', async () => {
      const oversizedPayload = 'x'.repeat(1_200_000)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/source/compile',
        headers: {
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ source: oversizedPayload }),
      })

      expect(res.statusCode).toBe(413)
      const json = res.json()
      expect(json.code).toBe('PAYLOAD_TOO_LARGE')
      expect(json.requestId).toBeDefined()
    })
  })
})
