import { ActivepiecesError, apId, ErrorCode } from '@inboxfm-connect/core-utils'
import { scheduler } from '@inboxfm-connect/scheduler'
import { ScheduledTaskStatus, TriggerBindingStatus } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduledTaskService } from '../../../../src/app/execution/scheduled-task/scheduled-task.service'
import { triggerBindingService } from '../../../../src/app/execution/trigger-binding/trigger-binding.service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

const createdTaskIds: string[] = []
const createdBindingIds: string[] = []

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
})

afterEach(async () => {
    vi.restoreAllMocks()
    for (const id of createdTaskIds) {
        await scheduler.cancel(`user-task-${id}`)
        await databaseConnection().getRepository('scheduled_task').delete({ id })
    }
    for (const id of createdBindingIds) {
        await scheduler.cancel(`trigger-cron-${id}`)
        await scheduler.cancel(`trigger-renew-${id}`)
        await databaseConnection().getRepository('trigger_binding').delete({ id })
    }
    createdTaskIds.length = 0
    createdBindingIds.length = 0
})

async function saveTaskRow(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    const now = new Date().toISOString()
    const row = {
        id: apId(),
        created: now,
        updated: now,
        projectId: ctx.project.id,
        platformId: ctx.platform.id,
        prompt: 'Nightly summary',
        cronExpression: '*/5 * * * *',
        timezone: 'UTC',
        status: ScheduledTaskStatus.ENABLED,
        lastRunAt: null,
        nextRunAt: null,
        ...overrides,
    }
    await db.save('scheduled_task', row)
    createdTaskIds.push(row.id as string)
    return row
}

async function saveBindingRow(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    const now = new Date().toISOString()
    const row = {
        id: apId(),
        created: now,
        updated: now,
        projectId: ctx.project.id,
        platformId: ctx.platform.id,
        pieceName: '@inboxfm-connect/piece-webhook',
        pieceVersion: '0.1.0',
        triggerName: 'catch_webhook',
        connectionId: null,
        promptTemplate: 'Handle {{item}}',
        settings: { cronExpression: '*/5 * * * *' },
        propertySettings: null,
        status: TriggerBindingStatus.ENABLED,
        ...overrides,
    }
    await db.save('trigger_binding', row)
    createdBindingIds.push(row.id as string)
    return row
}

describe('Scheduled task lifecycle (Issue #160)', () => {
    it('sets nextRunAt on create when ENABLED and null when DISABLED', async () => {
        const enabled = await scheduledTaskService.create({
            request: { prompt: 'Enabled task', cronExpression: '*/5 * * * *', timezone: 'UTC' },
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
        })
        createdTaskIds.push(enabled.id)
        expect(enabled.nextRunAt).not.toBeNull()
        expect(new Date(enabled.nextRunAt as string).getTime()).toBeGreaterThan(Date.now())

        const disabled = await scheduledTaskService.create({
            request: { prompt: 'Disabled task', cronExpression: '*/5 * * * *', status: 'DISABLED' },
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
        })
        createdTaskIds.push(disabled.id)
        expect(disabled.nextRunAt).toBeNull()
    })

    it('rejects an invalid cron at create time with a 4xx code instead of an orphan row', async () => {
        await scheduledTaskService.create({
            request: { prompt: 'Bad cron', cronExpression: 'not-a-cron' },
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
        }).then(
            () => {
                throw new Error('create with an invalid cron must throw')
            },
            (error: ActivepiecesError) => {
                expect(error.error.code).toBe(ErrorCode.VALIDATION)
            },
        )
        const rows = await db.findManyBy('scheduled_task', { prompt: 'Bad cron' })
        expect(rows).toHaveLength(0)
    })

    it('recomputes nextRunAt on update and clears it on disable', async () => {
        const created = await scheduledTaskService.create({
            request: { prompt: 'Shifting task', cronExpression: '*/5 * * * *', timezone: 'UTC' },
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
        })
        createdTaskIds.push(created.id)
        const before = created.nextRunAt as string

        // `3 * * * *` (minute 3) is disjoint from `*/5` (minutes 0,5,10,...):
        // 3 mod 5 !== 0, so the recomputed tick can never equal `before`, no
        // matter when the run lands. The previous `*/7` shared minutes 0 and 35
        // with `*/5`, so runs hitting those boundaries recomputed the same
        // timestamp and flaked the not.toBe(before) assertion.
        const updated = await scheduledTaskService.update({
            id: created.id,
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
            request: { cronExpression: '3 * * * *' },
        })
        expect(updated.nextRunAt).not.toBeNull()
        expect(updated.nextRunAt).not.toBe(before)

        const disabled = await scheduledTaskService.update({
            id: created.id,
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
            request: { status: 'DISABLED' },
        })
        expect(disabled.nextRunAt).toBeNull()
        expect(scheduler.has(`user-task-${created.id}`)).toBe(false)
    })

    it('threads the task timezone into the registered cron', async () => {
        const cronSpy = vi.spyOn(scheduler, 'cron')
        const created = await scheduledTaskService.create({
            request: { prompt: 'Kolkata task', cronExpression: '0 9 * * *', timezone: 'Asia/Kolkata' },
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
        })
        createdTaskIds.push(created.id)

        expect(cronSpy).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'Asia/Kolkata' }))
        expect(created.nextRunAt).not.toBeNull()
    })

    it('re-registers ENABLED tasks on boot, skips DISABLED and corrupt crons', async () => {
        const goodOne = await saveTaskRow({ prompt: 'Boot good one' })
        const goodTwo = await saveTaskRow({ prompt: 'Boot good two' })
        const disabled = await saveTaskRow({ prompt: 'Boot disabled', status: ScheduledTaskStatus.DISABLED })
        const corrupt = await saveTaskRow({ prompt: 'Boot corrupt', cronExpression: 'not-a-cron' })

        const result = await scheduledTaskService.reRegisterEnabledSchedules({ log: app!.log })

        expect(result).toEqual({ registered: 2, skipped: 1, total: 3 })
        expect(scheduler.has(`user-task-${goodOne.id}`)).toBe(true)
        expect(scheduler.has(`user-task-${goodTwo.id}`)).toBe(true)
        expect(scheduler.has(`user-task-${disabled.id}`)).toBe(false)
        expect(scheduler.has(`user-task-${corrupt.id}`)).toBe(false)

        const refreshed = await db.findOneBy<{ nextRunAt: string | null }>('scheduled_task', { id: goodOne.id })
        expect(refreshed?.nextRunAt).not.toBeNull()
    })

    it('tolerates a corrupt stored cron on dispatch without failing the execution', async () => {
        const row = await saveTaskRow({ prompt: 'Corrupt dispatch', cronExpression: 'not-a-cron' })

        const execution = await scheduledTaskService.triggerNow({
            id: row.id,
            projectId: ctx.project.id,
            platformId: ctx.platform.id,
        })

        expect(execution.id).toBeDefined()
        const refreshed = await db.findOneBy<{ nextRunAt: string | null }>('scheduled_task', { id: row.id })
        expect(refreshed?.nextRunAt).toBeNull()
    })
})

describe('Trigger binding boot restore (Issue #160)', () => {
    it('re-registers ENABLED bindings and leaves DISABLED ones untouched', async () => {
        const enabled = await saveBindingRow()
        const disabled = await saveBindingRow({ status: TriggerBindingStatus.DISABLED })

        const result = await triggerBindingService.reRegisterEnabledSchedules({ log: app!.log })

        expect(result).toEqual({ registered: 1, skipped: 0, total: 1 })
        expect(scheduler.has(`trigger-cron-${enabled.id}`)).toBe(true)
        expect(scheduler.has(`trigger-cron-${disabled.id}`)).toBe(false)
    })

    it('cleans up a half-installed binding when the renew cron fails', async () => {
        const binding = await saveBindingRow({
            settings: { cronExpression: '*/5 * * * *', renewCronExpression: 'not-a-cron' },
        })

        const result = await triggerBindingService.reRegisterEnabledSchedules({ log: app!.log })

        expect(result).toEqual({ registered: 0, skipped: 1, total: 1 })
        expect(scheduler.has(`trigger-cron-${binding.id}`)).toBe(false)
    })
})
