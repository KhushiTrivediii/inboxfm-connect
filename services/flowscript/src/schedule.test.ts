import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import {
  createFlowTrigger,
  enqueueDueSchedule,
  getStorePool,
  listFlowTriggers,
  setStorePool,
  validateScheduleConfig,
} from './store.js'
import { buildServer, signProjectId } from './server.js'

describe('flowscript scheduled triggers hardening (issue #656)', () => {
  let triggers: Map<string, any>
  let deployments: Map<string, any>
  let runs: Map<string, any>
  let occurrences: Map<string, any>
  let mockPool: any
  let originalPool: any
  let app: ReturnType<typeof buildServer>
  let executeQuery: (sql: string, params?: any[]) => Promise<any>

  beforeEach(() => {
    triggers = new Map()
    deployments = new Map()
    runs = new Map()
    occurrences = new Map()
    originalPool = getStorePool()
    app = buildServer()

    executeQuery = async (sql: string, params: any[] = []) => {
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

      if (trimmed.includes('FROM flowscript_triggers') && trimmed.includes("WHERE kind='schedule' AND enabled=true AND next_fire_at <= now()")) {
        const now = new Date()
        const dueList = Array.from(triggers.values()).filter(t => t.kind === 'schedule' && t.enabled && new Date(t.next_fire_at) <= now)
        dueList.sort((a, b) => new Date(a.next_fire_at).getTime() - new Date(b.next_fire_at).getTime())
        const first = dueList[0]
        if (!first) {
          return { rows: [], rowCount: 0 }
        }
        return {
          rows: [{
            id: first.id,
            project_id: first.project_id,
            flow_name: first.flow_name,
            environment: first.environment,
            config: first.config,
            next_fire_at: first.next_fire_at,
            last_fired_at: first.last_fired_at,
          }],
          rowCount: 1,
        }
      }

      if (trimmed.includes('FROM flowscript_schedule_occurrences WHERE trigger_id=$1 AND scheduled_instant=$2')) {
        const [triggerId, instant] = params
        const key = `${triggerId}:${new Date(instant).toISOString()}`
        const occ = occurrences.get(key)
        if (occ) {
          return { rows: [{ run_id: occ.run_id }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('INSERT INTO flowscript_runs')) {
        const [id, projectId, flowName, env, versionId] = params
        const runRecord = {
          id,
          project_id: projectId,
          flow_name: flowName,
          environment: env,
          version_id: versionId,
          trigger_kind: 'schedule',
          status: 'queued',
          input: {},
          created_at: new Date(),
        }
        runs.set(id, runRecord)
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('INSERT INTO flowscript_schedule_occurrences')) {
        const [id, triggerId, instant] = params
        const key = `${triggerId}:${new Date(instant).toISOString()}`
        if (!occurrences.has(key)) {
          occurrences.set(key, { id, trigger_id: triggerId, scheduled_instant: instant })
          return { rows: [{ id }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('UPDATE flowscript_schedule_occurrences SET run_id=$1 WHERE id=$2')) {
        const [runId, id] = params
        for (const occ of occurrences.values()) {
          if (occ.id === id) {
            occ.run_id = runId
            return { rows: [{ id }], rowCount: 1 }
          }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('UPDATE flowscript_triggers SET last_fired_at=now(), next_fire_at=$2, dispatch_lag_ms=$3, last_error=$4 WHERE id=$1')) {
        const [id, nextFireAt, lagMs, lastError] = params
        const trigger = triggers.get(id)
        if (trigger) {
          trigger.last_fired_at = new Date()
          trigger.next_fire_at = nextFireAt
          trigger.dispatch_lag_ms = lagMs
          trigger.last_error = lastError
        }
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('UPDATE flowscript_triggers SET last_error=$2, enabled=false WHERE id=$1')) {
        const [id, errorMsg] = params
        const trigger = triggers.get(id)
        if (trigger) {
          trigger.last_error = errorMsg
          trigger.enabled = false
        }
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('INSERT INTO flowscript_triggers')) {
        const [id, projectId, flowName, env, kind, configJson, nextFireAt] = params
        const config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson
        triggers.set(id, {
          id,
          project_id: projectId,
          flow_name: flowName,
          environment: env,
          kind,
          config,
          next_fire_at: nextFireAt,
          last_fired_at: null,
          dispatch_lag_ms: null,
          last_error: null,
          enabled: true,
          created_at: new Date(),
        })
        return { rows: [], rowCount: 1 }
      }

      if (trimmed.includes('SELECT id, flow_name, environment, kind, config, enabled, next_fire_at, last_fired_at, dispatch_lag_ms, last_error, created_at FROM flowscript_triggers')) {
        const [projectId, flowName] = params
        const matches = Array.from(triggers.values()).filter(t => t.project_id === projectId && t.flow_name === flowName)
        return { rows: matches, rowCount: matches.length }
      }

      if (trimmed.includes('UPDATE flowscript_triggers SET enabled=$4 WHERE id=$1 AND project_id=$2 AND flow_name=$3')) {
        const [triggerId, projectId, flowName, enabled] = params
        const tr = triggers.get(triggerId)
        if (tr && tr.project_id === projectId && tr.flow_name === flowName) {
          tr.enabled = enabled
          return { rows: [{ id: tr.id, flow_name: tr.flow_name, enabled: tr.enabled }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }

      if (trimmed.includes('DELETE FROM flowscript_triggers WHERE id=$1 AND project_id=$2 AND flow_name=$3')) {
        const [triggerId, projectId, flowName] = params
        const tr = triggers.get(triggerId)
        if (tr && tr.project_id === projectId && tr.flow_name === flowName) {
          triggers.delete(triggerId)
          return { rowCount: 1 }
        }
        return { rowCount: 0 }
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

  describe('validation semantics (validateScheduleConfig)', () => {
    it('rejects invalid or empty cron expressions', () => {
      const empty = validateScheduleConfig('')
      expect(empty.valid).toBe(false)
      if (!empty.valid) {
        expect(empty.path).toBe('cron')
        expect(empty.error).toContain('Cron expression is required')
      }

      const invalid = validateScheduleConfig('not-a-cron')
      expect(invalid.valid).toBe(false)
      if (!invalid.valid) {
        expect(invalid.path).toBe('cron')
        expect(invalid.error).toContain('Invalid cron expression')
      }
    })

    it('rejects invalid IANA timezone identifiers', () => {
      const result = validateScheduleConfig('*/5 * * * *', 'Mars/Phobos')
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.path).toBe('timezone')
        expect(result.error).toContain('Invalid IANA timezone')
      }
    })

    it('rejects invalid missedTickPolicy', () => {
      const result = validateScheduleConfig('*/5 * * * *', 'UTC', { missedTickPolicy: 'invalid-policy' })
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.path).toBe('missedTickPolicy')
        expect(result.error).toContain('Invalid missedTickPolicy')
      }
    })

    it('accepts valid cron, IANA timezone and policy', () => {
      const result = validateScheduleConfig('0 9 * * 1-5', 'America/New_York', { missedTickPolicy: 'catch-up' })
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.cron).toBe('0 9 * * 1-5')
        expect(result.timezone).toBe('America/New_York')
        expect(result.missedTickPolicy).toBe('catch-up')
        expect(result.nextFireAt).toBeInstanceOf(Date)
      }
    })
  })

  describe('HTTP endpoint schedule validation', () => {
    it('returns path-specific 400 when cron is malformed', async () => {
      const projectId = 'proj-sched-1'
      const token = signProjectId(projectId)

      const res = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/triggers',
        headers: {
          'x-project-id': projectId,
          'x-project-signature': token,
        },
        payload: {
          kind: 'schedule',
          cron: 'bad cron expression',
          timezone: 'UTC',
        },
      })

      expect(res.statusCode).toBe(400)
      const body = res.json()
      expect(body.path).toBe('cron')
      expect(body.error).toContain('Invalid cron expression')
    })

    it('returns path-specific 400 when timezone is invalid', async () => {
      const projectId = 'proj-sched-1'
      const token = signProjectId(projectId)

      const res = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/triggers',
        headers: {
          'x-project-id': projectId,
          'x-project-signature': token,
        },
        payload: {
          kind: 'schedule',
          cron: '*/15 * * * *',
          timezone: 'Invalid/City_Nowhere',
        },
      })

      expect(res.statusCode).toBe(400)
      const body = res.json()
      expect(body.path).toBe('timezone')
      expect(body.error).toContain('Invalid IANA timezone')
    })

    it('successfully registers schedule trigger with valid cron and timezone', async () => {
      const projectId = 'proj-sched-1'
      const token = signProjectId(projectId)

      // Set up active deployment
      deployments.set('dep-1', {
        id: 'dep-1',
        project_id: projectId,
        flow_name: 'my-flow',
        environment: 'production',
        version_id: 'ver-1',
        status: 'active',
      })

      const res = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/triggers',
        headers: {
          'x-project-id': projectId,
          'x-project-signature': token,
        },
        payload: {
          kind: 'schedule',
          cron: '0 12 * * *',
          timezone: 'Europe/London',
          missedTickPolicy: 'run-once',
        },
      })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.id).toBeDefined()
      expect(body.kind).toBe('schedule')
      expect(body.config.cron).toBe('0 12 * * *')
      expect(body.config.timezone).toBe('Europe/London')
      expect(body.config.missedTickPolicy).toBe('run-once')
      expect(body.nextFireAt).toBeDefined()
    })
  })

  describe('concurrent worker scheduling deduplication', () => {
    it('ensures only one run is enqueued for a scheduled instant under concurrency', async () => {
      const projectId = 'proj-concurrency'
      const triggerId = 'trig-due-1'
      const scheduledInstant = new Date(Date.now() - 5000)

      deployments.set('dep-conc', {
        id: 'dep-conc',
        project_id: projectId,
        flow_name: 'timed-flow',
        environment: 'production',
        version_id: 'ver-conc',
        status: 'active',
      })

      triggers.set(triggerId, {
        id: triggerId,
        project_id: projectId,
        flow_name: 'timed-flow',
        environment: 'production',
        kind: 'schedule',
        config: { cron: '*/5 * * * *', timezone: 'UTC', missedTickPolicy: 'run-once' },
        next_fire_at: scheduledInstant,
        last_fired_at: null,
        enabled: true,
      })

      // Simulate 2 concurrent workers attempting to process the due trigger
      const [worker1Result, worker2Result] = await Promise.all([
        enqueueDueSchedule(),
        enqueueDueSchedule(),
      ])

      // Only 1 run should have been created across both worker calls
      expect(runs.size).toBe(1)
      expect(occurrences.size).toBe(1)

      const occ = Array.from(occurrences.values())[0]
      expect(occ.trigger_id).toBe(triggerId)

      const trigger = triggers.get(triggerId)
      expect(new Date(trigger.next_fire_at).getTime()).toBeGreaterThan(Date.now())
      expect(trigger.last_fired_at).toBeDefined()
      expect(trigger.dispatch_lag_ms).toBeGreaterThanOrEqual(5000)
    })
  })

  describe('missed-tick recovery policies', () => {
    it('run-once policy advances next_fire_at from current time without tick cascade', async () => {
      const projectId = 'proj-missed'
      const triggerId = 'trig-missed-1'
      // Simulated downtime of 3 days
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000)

      deployments.set('dep-missed', {
        id: 'dep-missed',
        project_id: projectId,
        flow_name: 'hourly-sync',
        environment: 'production',
        version_id: 'ver-missed',
        status: 'active',
      })

      triggers.set(triggerId, {
        id: triggerId,
        project_id: projectId,
        flow_name: 'hourly-sync',
        environment: 'production',
        kind: 'schedule',
        config: { cron: '0 * * * *', timezone: 'UTC', missedTickPolicy: 'run-once' },
        next_fire_at: threeDaysAgo,
        last_fired_at: null,
        enabled: true,
      })

      const result = await enqueueDueSchedule()
      expect(result).toBeTruthy()
      expect(runs.size).toBe(1)

      const trigger = triggers.get(triggerId)
      // The next fire time should be in the future relative to now, not relative to threeDaysAgo
      expect(new Date(trigger.next_fire_at).getTime()).toBeGreaterThan(Date.now())
      // Lag recorded should accurately reflect the 3 days of downtime
      expect(trigger.dispatch_lag_ms).toBeGreaterThanOrEqual(3 * 24 * 3600 * 1000)
    })

    it('catch-up policy advances next_fire_at step-by-step from scheduled instant', async () => {
      const projectId = 'proj-catchup'
      const triggerId = 'trig-catchup-1'
      // 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000)

      deployments.set('dep-catchup', {
        id: 'dep-catchup',
        project_id: projectId,
        flow_name: 'batch-sync',
        environment: 'production',
        version_id: 'ver-catchup',
        status: 'active',
      })

      triggers.set(triggerId, {
        id: triggerId,
        project_id: projectId,
        flow_name: 'batch-sync',
        environment: 'production',
        kind: 'schedule',
        config: { cron: '0 * * * *', timezone: 'UTC', missedTickPolicy: 'catch-up' },
        next_fire_at: twoHoursAgo,
        last_fired_at: null,
        enabled: true,
      })

      await enqueueDueSchedule()
      const trigger = triggers.get(triggerId)

      // With catch-up, nextFireAt was computed from twoHoursAgo, so it advances by 1 interval
      const expectedNext = CronExpressionParser.parse('0 * * * *', { currentDate: twoHoursAgo, tz: 'UTC' }).next().toDate()
      expect(new Date(trigger.next_fire_at).toISOString()).toBe(expectedNext.toISOString())
    })
  })

  describe('daylight-saving (DST) transition handling', () => {
    it('handles spring-forward jump safely without duplicate ticks or throwing', () => {
      // In America/New_York, 2:00 AM springs forward to 3:00 AM on 2026-03-08
      const parser = CronExpressionParser.parse('30 2 * * *', {
        currentDate: new Date('2026-03-08T00:00:00-05:00'),
        tz: 'America/New_York',
      })

      const next = parser.next().toDate()
      expect(next).toBeInstanceOf(Date)
      // Must not throw or produce invalid timestamps
      expect(next.getTime()).toBeGreaterThan(new Date('2026-03-08T00:00:00-05:00').getTime())
    })

    it('handles fall-back repeated hour safely with unique UTC instant deduplication', () => {
      // In America/New_York, clocks fall back on 2026-11-01
      const parser = CronExpressionParser.parse('30 1 * * *', {
        currentDate: new Date('2026-11-01T00:00:00-04:00'),
        tz: 'America/New_York',
      })

      const tick1 = parser.next().toDate()
      const tick2 = parser.next().toDate()
      // Successive ticks must have strictly increasing UTC timestamps
      expect(tick2.getTime()).toBeGreaterThan(tick1.getTime())
    })
  })

  describe('paused, deleted, and errored triggers', () => {
    it('does not dispatch paused triggers', async () => {
      const triggerId = 'trig-paused-1'
      triggers.set(triggerId, {
        id: triggerId,
        project_id: 'p1',
        flow_name: 'test-flow',
        environment: 'production',
        kind: 'schedule',
        config: { cron: '* * * * *', timezone: 'UTC' },
        next_fire_at: new Date(Date.now() - 1000),
        enabled: false,
      })

      const result = await enqueueDueSchedule()
      expect(result).toBe(false)
      expect(runs.size).toBe(0)
    })

    it('exposes last_error and disables trigger on corrupted cron config', async () => {
      const triggerId = 'trig-corrupted-1'
      triggers.set(triggerId, {
        id: triggerId,
        project_id: 'p1',
        flow_name: 'corrupted-flow',
        environment: 'production',
        kind: 'schedule',
        config: { cron: 'corrupted cron text', timezone: 'UTC' },
        next_fire_at: new Date(Date.now() - 1000),
        enabled: true,
      })

      await enqueueDueSchedule()
      const trigger = triggers.get(triggerId)
      expect(trigger.enabled).toBe(false)
      expect(trigger.last_error).toBeDefined()
      expect(trigger.last_error).toMatch(/validation error|cron/i)
    })

    it('exposes trigger diagnostics via listFlowTriggers', async () => {
      const projectId = 'proj-diag'
      triggers.set('trig-d1', {
        id: 'trig-d1',
        project_id: projectId,
        flow_name: 'diag-flow',
        environment: 'production',
        kind: 'schedule',
        config: { cron: '0 * * * *', timezone: 'UTC' },
        enabled: true,
        next_fire_at: new Date(),
        last_fired_at: new Date(Date.now() - 60000),
        dispatch_lag_ms: 124,
        last_error: null,
        created_at: new Date(),
      })

      const list = await listFlowTriggers(projectId, 'diag-flow')
      expect(list.length).toBe(1)
      expect(list[0].dispatchLagMs).toBe(124)
      expect(list[0].lastFiredAt).toBeDefined()
      expect(list[0].nextFireAt).toBeDefined()
      expect(list[0].lastError).toBeNull()
    })

    it('skips enqueuing run for missed ticks when policy is skip', async () => {
      const triggerId = 'trig-skip-1'
      const threeDaysAgo = new Date(Date.now() - 3 * 86400 * 1000)
      triggers.set(triggerId, {
        id: triggerId,
        project_id: 'p1',
        flow_name: 'test-flow',
        environment: 'production',
        kind: 'schedule',
        config: { cron: '0 * * * *', timezone: 'UTC', missedTickPolicy: 'skip' },
        next_fire_at: threeDaysAgo,
        enabled: true,
      })
      deployments.set('dep-1', {
        version_id: 'v1',
        project_id: 'p1',
        flow_name: 'test-flow',
        environment: 'production',
        status: 'active',
      })

      const result = await enqueueDueSchedule()
      expect(result).toBeDefined()
      expect((result as any).enqueued).toBe(false)
      expect((result as any).runId).toBeUndefined()
      expect(runs.size).toBe(0)

      const updated = triggers.get(triggerId)
      expect(new Date(updated.next_fire_at).getTime()).toBeGreaterThan(Date.now())
    })

    it('records last_error when trigger is due but no active deployment exists', async () => {
      const triggerId = 'trig-no-dep'
      triggers.set(triggerId, {
        id: triggerId,
        project_id: 'p1',
        flow_name: 'undeployed-flow',
        environment: 'production',
        kind: 'schedule',
        config: { cron: '* * * * *', timezone: 'UTC' },
        next_fire_at: new Date(Date.now() - 1000),
        enabled: true,
      })

      const result = await enqueueDueSchedule()
      expect((result as any).enqueued).toBe(false)
      const updated = triggers.get(triggerId)
      expect(updated.last_error).toContain('No active deployment')
      expect(runs.size).toBe(0)
    })

    it('rolls back and leaves state recoverable on unexpected database error', async () => {
      let rollbackCalled = false
      let failNextQuery = true
      const originalConnect = mockPool.connect
      mockPool.connect = async () => ({
        query: async (sql: string, params?: any[]) => {
          if (sql === 'ROLLBACK') {
            rollbackCalled = true
            return { rows: [], rowCount: 0 }
          }
          if (failNextQuery && sql.includes('INSERT INTO flowscript_runs')) {
            failNextQuery = false
            throw new Error('Simulated database connection failure')
          }
          return executeQuery(sql, params)
        },
        release: () => {},
      })

      triggers.set('trig-fail-1', {
        id: 'trig-fail-1',
        project_id: 'p1',
        flow_name: 'test-flow',
        environment: 'production',
        kind: 'schedule',
        config: { cron: '* * * * *', timezone: 'UTC' },
        next_fire_at: new Date(Date.now() - 1000),
        enabled: true,
      })
      deployments.set('dep-1', {
        version_id: 'v1',
        project_id: 'p1',
        flow_name: 'test-flow',
        environment: 'production',
        status: 'active',
      })

      await expect(enqueueDueSchedule()).rejects.toThrow('Simulated database connection failure')
      expect(rollbackCalled).toBe(true)
      const trig = triggers.get('trig-fail-1')
      expect(trig.enabled).toBe(true)
      mockPool.connect = originalConnect
    })
  })
})
