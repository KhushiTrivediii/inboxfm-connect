import { scheduler } from '@inboxfm-connect/scheduler'
import { ExecutionStatus, ScheduledTaskStatus } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { vi } from 'vitest'
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

describe('Scheduled trigger flow execution lifecycle (scheduler -> execution)', () => {
    it('schedules task in scheduler on creation and triggers an execution into the test stack', async () => {
        const ctx = await createTestContext(app!)

        // 1. Create enabled scheduled task
        const createRes = await ctx.post('/v1/scheduled-tasks', {
            projectId: ctx.project.id,
            prompt: 'Hourly sync prompt',
            cronExpression: '0 * * * *',
            timezone: 'UTC',
            status: ScheduledTaskStatus.ENABLED,
        })

        expect(createRes?.statusCode).toBe(StatusCodes.CREATED)
        const task = createRes!.json()
        expect(task.id).toBeDefined()
        expect(task.status).toBe(ScheduledTaskStatus.ENABLED)

        // Verify task is registered in active scheduler
        const jobName = `user-task-${task.id}`
        expect(scheduler.has(jobName)).toBe(true)

        // 2. Trigger the scheduled task execution
        const runRes = await ctx.post(`/v1/scheduled-tasks/${task.id}/run`)
        expect(runRes?.statusCode).toBe(StatusCodes.OK)
        const execution = runRes!.json()

        expect(execution).toBeDefined()
        expect(execution.id).toBeDefined()
        expect(execution.projectId).toBe(ctx.project.id)
        expect(execution.platformId).toBe(ctx.platform.id)
        expect(execution.prompt).toBe('Hourly sync prompt')
        expect(execution.status).toBe(ExecutionStatus.CREATED)
        expect(execution.metadata).toMatchObject({
            scheduledTaskId: task.id,
            cronExpression: '0 * * * *',
            timezone: 'UTC',
        })

        // 3. Verify the execution row was persisted in the database and visible in execution list
        const listRes = await ctx.get('/v1/executions', { projectId: ctx.project.id })
        expect(listRes?.statusCode).toBe(StatusCodes.OK)
        const executions = listRes!.json().data
        const found = executions.find((e: { id: string }) => e.id === execution.id)
        expect(found).toBeDefined()
        expect(found.metadata.scheduledTaskId).toBe(task.id)

        // 4. Disable the scheduled task and verify it is unscheduled
        const disableRes = await ctx.post(`/v1/scheduled-tasks/${task.id}`, {
            status: ScheduledTaskStatus.DISABLED,
        })
        expect(disableRes?.statusCode).toBe(StatusCodes.OK)
        expect(scheduler.has(jobName)).toBe(false)

        // 5. Re-enable and verify it is re-registered
        const enableRes = await ctx.post(`/v1/scheduled-tasks/${task.id}`, {
            status: ScheduledTaskStatus.ENABLED,
        })
        expect(enableRes?.statusCode).toBe(StatusCodes.OK)
        expect(scheduler.has(jobName)).toBe(true)

        // 6. Delete task and verify clean removal from scheduler
        const deleteRes = await ctx.delete(`/v1/scheduled-tasks/${task.id}`)
        expect(deleteRes?.statusCode).toBe(StatusCodes.NO_CONTENT)
        expect(scheduler.has(jobName)).toBe(false)
    })

    it('scheduler.once dispatches an execution directly into the test database', async () => {
        const ctx = await createTestContext(app!)
        const { executionService } = await import('../../../../src/app/execution/execution.service')

        let createdExecutionId: string | null = null

        const taskId = await scheduler.once({
            name: 'test-scheduled-flow-dispatch',
            delayMs: 10,
            fn: async () => {
                const exec = await executionService.create({
                    prompt: 'Automated scheduler flow run',
                    metadata: { source: 'scheduler-test' },
                    projectId: ctx.project.id,
                    platformId: ctx.platform.id,
                })
                createdExecutionId = exec.id
            },
        })

        expect(scheduler.has(taskId)).toBe(true)

        await vi.waitFor(() => expect(createdExecutionId).not.toBeNull(), { timeout: 5000, interval: 10 })

        expect(scheduler.has(taskId)).toBe(false)
        expect(createdExecutionId).toBeDefined()

        const row = await db.findOneBy<Record<string, unknown>>('execution', { id: createdExecutionId, projectId: ctx.project.id, platformId: ctx.platform.id })
        expect(row).toBeDefined()
        expect(row?.prompt).toBe('Automated scheduler flow run')
        expect(row?.projectId).toBe(ctx.project.id)
    })
})
