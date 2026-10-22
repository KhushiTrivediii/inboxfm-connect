import { apId } from '@inboxfm-connect/core-utils'
import { cronParser, scheduler } from '@inboxfm-connect/scheduler'
import { ErrorCode, ScheduledTaskStatus, TriggerBindingStatus } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { scheduledTaskService } from '../../../../src/app/execution/scheduled-task/scheduled-task.service'
import { triggerBindingService } from '../../../../src/app/execution/trigger-binding/trigger-binding.service'
import { db } from '../../../helpers/db'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await scheduler.shutdown()
    await teardownTestEnvironment()
})

describe('Scheduled tasks restart-safe re-registration, nextRunAt, and multi-instance handling (#160)', () => {
    it('rejects invalid cron expressions on create with ErrorCode.VALIDATION', async () => {
        const ctx = await createTestContext(app!)

        const res = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Invalid task',
            cronExpression: 'not a cron expression',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
        })

        expect(res?.statusCode).toBe(StatusCodes.CONFLICT)
        const body = res!.json()
        expect(body.code).toBe(ErrorCode.VALIDATION)
        expect(body.params?.message).toContain('Invalid cron expression')
    })

    it('rejects invalid cron expressions on update with ErrorCode.VALIDATION', async () => {
        const ctx = await createTestContext(app!)

        const createRes = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Valid task initially',
            cronExpression: '*/15 * * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
        })
        expect(createRes?.statusCode).toBe(StatusCodes.CREATED)
        const task = createRes!.json()

        const updateRes = await ctx.post(`/v1/scheduled-tasks/${task.id}`, {
            cronExpression: 'invalid-cron-update',
        })
        expect(updateRes?.statusCode).toBe(StatusCodes.CONFLICT)
        const body = updateRes!.json()
        expect(body.code).toBe(ErrorCode.VALIDATION)
    })

    it('populates nextRunAt on create for ENABLED task and leaves null for DISABLED task', async () => {
        const ctx = await createTestContext(app!)

        // 1. Enabled task
        const enabledRes = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Enabled sync',
            cronExpression: '0 12 * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
        })
        expect(enabledRes?.statusCode).toBe(StatusCodes.CREATED)
        const enabledTask = enabledRes!.json()
        expect(enabledTask.nextRunAt).not.toBeNull()
        const expectedNextTick = cronParser.computeNextTick({ cronExpression: '0 12 * * *', timezone: 'UTC' }).toISOString()
        expect(enabledTask.nextRunAt).toBe(expectedNextTick)

        // 2. Disabled task
        const disabledRes = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Disabled sync',
            cronExpression: '0 12 * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.DISABLED,
        })
        expect(disabledRes?.statusCode).toBe(StatusCodes.CREATED)
        const disabledTask = disabledRes!.json()
        expect(disabledTask.nextRunAt).toBeNull()
    })

    it('recalculates nextRunAt on update when status or cron changes', async () => {
        const ctx = await createTestContext(app!)

        const createRes = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Dynamic sync',
            cronExpression: '0 10 * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
        })
        const task = createRes!.json()
        expect(task.nextRunAt).not.toBeNull()

        // Disable task -> nextRunAt becomes null
        const disableRes = await ctx.post(`/v1/scheduled-tasks/${task.id}`, {
            status: ScheduledTaskStatus.DISABLED,
        })
        expect(disableRes?.statusCode).toBe(StatusCodes.OK)
        expect(disableRes!.json().nextRunAt).toBeNull()

        // Re-enable with new cron -> nextRunAt recomputed with new cron
        const reenableRes = await ctx.post(`/v1/scheduled-tasks/${task.id}`, {
            status: ScheduledTaskStatus.ENABLED,
            cronExpression: '0 18 * * *',
        })
        expect(reenableRes?.statusCode).toBe(StatusCodes.OK)
        const updated = reenableRes!.json()
        expect(updated.nextRunAt).not.toBeNull()
        const expectedNext = cronParser.computeNextTick({ cronExpression: '0 18 * * *', timezone: 'UTC' }).toISOString()
        expect(updated.nextRunAt).toBe(expectedNext)
    })

    it('refreshes lastRunAt and nextRunAt on task dispatch', async () => {
        const ctx = await createTestContext(app!)

        const createRes = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Run test prompt',
            cronExpression: '30 * * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
        })
        const task = createRes!.json()
        expect(task.lastRunAt).toBeNull()

        // Trigger manual run
        const runRes = await ctx.post(`/v1/scheduled-tasks/${task.id}/run`)
        expect(runRes?.statusCode).toBe(StatusCodes.OK)

        // Read from DB
        const saved = await db.findOneBy<{ id: string, lastRunAt: string | null, nextRunAt: string | null }>('scheduled_task', { id: task.id })
        expect(saved?.lastRunAt).not.toBeNull()
        expect(saved?.nextRunAt).not.toBeNull()
    })

    it('reRegisterEnabledSchedules restores all ENABLED tasks and trigger bindings on boot', async () => {
        const ctx = await createTestContext(app!)

        // 1. Create enabled task and trigger binding
        const taskRes = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Boot restore task',
            cronExpression: '15 4 * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
        })
        const task = taskRes!.json()
        const taskJobName = `user-task-${task.id}`

        const bindingId = apId()
        const now = new Date().toISOString()
        await db.save('trigger_binding', {
            id: bindingId,
            created: now,
            updated: now,
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
            pieceName: '@inboxfm-connect/piece-schedule',
            pieceVersion: '0.1.0',
            triggerName: 'cron_trigger',
            connectionId: null,
            promptTemplate: 'Run on cron',
            settings: {
                cronExpression: '0 0 * * *',
            },
            propertySettings: null,
            status: TriggerBindingStatus.ENABLED,
        })
        const triggerJobName = `trigger-cron-${bindingId}`

        // Both are in scheduler or ready to be restored
        expect(scheduler.has(taskJobName)).toBe(true)

        // 2. Simulate server restart / crash by shutting down scheduler
        await scheduler.shutdown()
        expect(scheduler.has(taskJobName)).toBe(false)
        expect(scheduler.has(triggerJobName)).toBe(false)

        // 3. Run boot re-registration
        const taskResult = await scheduledTaskService.reRegisterEnabledSchedules({ log: app!.log })
        const bindingResult = await triggerBindingService.reRegisterEnabledSchedules({ log: app!.log })

        expect(taskResult.registered).toBeGreaterThanOrEqual(1)
        expect(bindingResult.registered).toBeGreaterThanOrEqual(1)

        // Verify scheduler now holds both jobs again
        expect(scheduler.has(taskJobName)).toBe(true)
        expect(scheduler.has(triggerJobName)).toBe(true)

        // Verify nextRunAt in DB is populated
        const refreshedTask = await db.findOneBy<{ id: string, nextRunAt: string | null }>('scheduled_task', { id: task.id })
        expect(refreshedTask?.nextRunAt).not.toBeNull()
    })

    it('skips corrupted legacy cron rows during boot without failing good tasks', async () => {
        const ctx = await createTestContext(app!)

        // Seed a corrupt row directly into DB bypassing validation
        const corruptId = apId()
        const now = new Date().toISOString()
        await db.save('scheduled_task', {
            id: corruptId,
            created: now,
            updated: now,
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
            prompt: 'Corrupt task',
            cronExpression: 'invalid_cron_in_db',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
            lastRunAt: null,
            nextRunAt: null,
        })

        // Also seed a valid row
        const validId = apId()
        await db.save('scheduled_task', {
            id: validId,
            created: now,
            updated: now,
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
            prompt: 'Valid task',
            cronExpression: '0 5 * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
            lastRunAt: null,
            nextRunAt: null,
        })

        await scheduler.shutdown()

        // Boot re-registration must succeed and register the valid task despite the corrupted one
        const result = await scheduledTaskService.reRegisterEnabledSchedules({ log: app!.log })
        expect(result.registered).toBeGreaterThanOrEqual(1)
        expect(scheduler.has(`user-task-${validId}`)).toBe(true)
        expect(scheduler.has(`user-task-${corruptId}`)).toBe(false)
    })

    it('multi-instance tick lock prevents duplicate execution on the same tick', async () => {
        const { distributedStore } = await import('../../../../src/app/database/redis-connections')
        const { getScheduledTaskTickLockKey } = await import('../../../../src/app/database/redis/keys')

        const testTaskId = apId()
        const lockKey = getScheduledTaskTickLockKey(testTaskId)

        // First instance claims the tick
        const firstClaim = await distributedStore.putIfAbsent(lockKey, 1, 55)
        expect(firstClaim).toBe(true)

        // Second replica attempting to claim the same tick is rejected
        const secondClaim = await distributedStore.putIfAbsent(lockKey, 1, 55)
        expect(secondClaim).toBe(false)

        // Clean up
        await distributedStore.delete(lockKey)
    })

    it('rejects invalid timezone on create with ErrorCode.VALIDATION', async () => {
        const ctx = await createTestContext(app!)

        const res = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Invalid tz task',
            cronExpression: '0 12 * * *',
            timezone: 'Invalid/Timezone_Name',
            status: ScheduledTaskStatus.ENABLED,
        })

        expect(res?.statusCode).toBe(StatusCodes.CONFLICT)
        const body = res!.json()
        expect(body.code).toBe(ErrorCode.VALIDATION)
        expect(body.params?.message).toContain('Invalid timezone')
    })

    it('rejects invalid timezone on update with ErrorCode.VALIDATION', async () => {
        const ctx = await createTestContext(app!)

        const createRes = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Valid tz task initially',
            cronExpression: '0 12 * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
        })
        const task = createRes!.json()

        const updateRes = await ctx.post(`/v1/scheduled-tasks/${task.id}`, {
            timezone: 'Bad/Zone',
        })
        expect(updateRes?.statusCode).toBe(StatusCodes.CONFLICT)
        const body = updateRes!.json()
        expect(body.code).toBe(ErrorCode.VALIDATION)
    })

    it('supports valid non-UTC timezone and computes nextRunAt correctly', async () => {
        const ctx = await createTestContext(app!)

        const res = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'NYC timezone task',
            cronExpression: '0 9 * * *',
            timezone: 'America/New_York',
            status: ScheduledTaskStatus.ENABLED,
        })
        expect(res?.statusCode).toBe(StatusCodes.CREATED)
        const task = res!.json()
        expect(task.timezone).toBe('America/New_York')
        const expected = cronParser.computeNextTick({ cronExpression: '0 9 * * *', timezone: 'America/New_York' }).toISOString()
        expect(task.nextRunAt).toBe(expected)
    })

    it('cancels scheduled job in scheduler when task is disabled via API', async () => {
        const ctx = await createTestContext(app!)

        const res = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Task to disable',
            cronExpression: '0 15 * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
        })
        const task = res!.json()
        const jobName = `user-task-${task.id}`
        expect(scheduler.has(jobName)).toBe(true)

        // Disable via API
        const disableRes = await ctx.post(`/v1/scheduled-tasks/${task.id}`, {
            status: ScheduledTaskStatus.DISABLED,
        })
        expect(disableRes?.statusCode).toBe(StatusCodes.OK)
        expect(scheduler.has(jobName)).toBe(false)
    })

    it('manual run of a DISABLED task writes lastRunAt but preserves null nextRunAt', async () => {
        const ctx = await createTestContext(app!)

        const res = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Disabled manual run task',
            cronExpression: '0 12 * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.DISABLED,
        })
        const task = res!.json()
        expect(task.nextRunAt).toBeNull()

        // Trigger manual run
        const runRes = await ctx.post(`/v1/scheduled-tasks/${task.id}/run`)
        expect(runRes?.statusCode).toBe(StatusCodes.OK)

        // Read from DB
        const saved = await db.findOneBy<{ id: string, lastRunAt: string | null, nextRunAt: string | null }>('scheduled_task', { id: task.id })
        expect(saved?.lastRunAt).not.toBeNull()
        expect(saved?.nextRunAt).toBeNull()
    })

    it('boot re-registration handles database query failure gracefully without throwing', async () => {
        const { repoFactory } = await import('../../../../src/app/core/db/repo-factory')
        const { ScheduledTaskEntity } = await import('../../../../src/app/execution/scheduled-task/scheduled-task-entity')
        const { TriggerBindingEntity } = await import('../../../../src/app/execution/trigger-binding/trigger-binding-entity')

        const scheduledRepo = repoFactory(ScheduledTaskEntity)()
        const triggerRepo = repoFactory(TriggerBindingEntity)()

        const scheduledSpy = vi.spyOn(scheduledRepo, 'findBy').mockRejectedValueOnce(new Error('DB connection refused'))
        const triggerSpy = vi.spyOn(triggerRepo, 'findBy').mockRejectedValueOnce(new Error('DB connection refused'))

        const taskResult = await scheduledTaskService.reRegisterEnabledSchedules({ log: app!.log })
        const bindingResult = await triggerBindingService.reRegisterEnabledSchedules({ log: app!.log })

        expect(taskResult.registered).toBe(0)
        expect(bindingResult.registered).toBe(0)

        scheduledSpy.mockRestore()
        triggerSpy.mockRestore()
    })
})
