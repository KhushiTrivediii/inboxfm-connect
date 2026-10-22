import { apId } from '@inboxfm-connect/core-utils'
import { ExecutionEventType, ExecutionStatus, ExecutionToolCallStatus } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { executionEventService } from '../../../../src/app/execution/execution-event.service'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

async function createExecutionViaApi(ctx: TestContext, prompt: string): Promise<{ id: string }> {
    const response = await ctx.post('/v1/executions', {
        projectId: ctx.project.id,
        prompt,
    })
    expect(response?.statusCode).toBe(StatusCodes.CREATED)
    return response!.json()
}

async function saveExecutionRow(
    ctx: TestContext,
    prompt: string,
    overrides: { status?: ExecutionStatus, created?: string } = {},
): Promise<{ id: string }> {
    const now = overrides.created ?? new Date().toISOString()
    const row = {
        id: apId(),
        created: now,
        updated: now,
        projectId: ctx.project.id,
        platformId: ctx.platform.id,
        userId: ctx.user.id,
        status: overrides.status ?? ExecutionStatus.CREATED,
        prompt,
        metadata: {},
        tokenUsage: null,
        cost: null,
        finishTime: null,
    }
    await db.save('execution', row)
    return row
}


async function saveToolCallRow(params: { executionId: string, projectId: string }): Promise<{ id: string }> {
    const now = new Date().toISOString()
    const row = {
        id: apId(),
        created: now,
        updated: now,
        executionId: params.executionId,
        projectId: params.projectId,
        pieceName: '@inboxfm-connect/piece-slack',
        pieceVersion: '0.1.0',
        actionName: 'send_message',
        connectionId: null,
        input: { text: 'hello' },
        output: { ok: true },
        status: ExecutionToolCallStatus.SUCCEEDED,
        error: null,
        latencyMs: 42,
        finished: now,
    }
    await db.save('tool_call', row)
    return row
}

async function saveTriggerBindingRow(ctx: TestContext): Promise<{ id: string }> {
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
        settings: {},
        propertySettings: null,
        status: 'ENABLED',
    }
    await db.save('trigger_binding', row)
    return row
}

async function saveScheduledTaskRow(ctx: TestContext): Promise<{ id: string }> {
    const now = new Date().toISOString()
    const row = {
        id: apId(),
        created: now,
        updated: now,
        projectId: ctx.project.id,
        platformId: ctx.platform.id,
        prompt: 'Compile the daily revenue summary',
        cronExpression: '0 8 * * *',
        timezone: 'UTC',
        status: 'ENABLED',
        lastRunAt: null,
        nextRunAt: null,
    }
    await db.save('scheduled_task', row)
    return row
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitUntil: condition not met within timeout')
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

describe('Execution authorization (USER principal, :id routes)', () => {
    describe('GET /v1/executions/:id', () => {
        it('resolves the tenant from the execution row for its own project', async () => {
            const ctx = await createTestContext(app!)
            const execution = await createExecutionViaApi(ctx, 'Summarize new issues')

            const response = await ctx.get(`/v1/executions/${execution.id}`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response!.json()
            expect(body.id).toBe(execution.id)
            expect(body.projectId).toBe(ctx.project.id)
            expect(body.status).toBe(ExecutionStatus.CREATED)
        })

        it('denies access to an execution owned by another project', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)
            const execution = await saveExecutionRow(ctxA, 'Project A only')

            const response = await ctxB.get(`/v1/executions/${execution.id}`)

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('returns not found for an unknown execution id', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.get(`/v1/executions/${apId()}`)

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })

    describe('GET /v1/executions/:id/tool-calls', () => {
        it('returns the tool calls of its own execution', async () => {
            const ctx = await createTestContext(app!)
            const execution = await saveExecutionRow(ctx, 'With tool calls')
            const toolCall = await saveToolCallRow({ executionId: execution.id, projectId: ctx.project.id })

            const response = await ctx.get(`/v1/executions/${execution.id}/tool-calls`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response!.json()
            expect(body).toHaveLength(1)
            expect(body[0].id).toBe(toolCall.id)
            expect(body[0].status).toBe(ExecutionToolCallStatus.SUCCEEDED)
        })

        it('returns an empty list when nothing wrote tool calls', async () => {
            const ctx = await createTestContext(app!)
            const execution = await saveExecutionRow(ctx, 'No tool calls')

            const response = await ctx.get(`/v1/executions/${execution.id}/tool-calls`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response!.json()).toEqual([])
        })

        it('denies access to tool calls of another project execution', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)
            const execution = await saveExecutionRow(ctxA, 'Project A only')
            await saveToolCallRow({ executionId: execution.id, projectId: ctxA.project.id })

            const response = await ctxB.get(`/v1/executions/${execution.id}/tool-calls`)

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })

    describe('GET /v1/executions/:id/events (SSE)', () => {
        it('streams data-only frames to the owning project', async () => {
            const ctx = await createTestContext(app!)
            const execution = await saveExecutionRow(ctx, 'Streamed execution')

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/executions/${execution.id}/events`,
                payloadAsStream: true,
            })

            expect(response.statusCode).toBe(StatusCodes.OK)
            expect(response.headers['content-type']).toBe('text/event-stream')

            const stream = response.stream()
            let received = ''
            stream.on('data', (chunk: Buffer) => {
                received += chunk.toString()
            })

            await executionEventService.emit({
                executionId: execution.id,
                type: ExecutionEventType.ExecutionStarted,
                payload: { executionId: execution.id, prompt: 'Streamed execution', timestamp: new Date().toISOString() },
            })

            await waitUntil(() => received.includes('data: '))

            expect(received.startsWith('id: ')).toBe(true)
            expect(received.endsWith('\n\n')).toBe(true)
            expect(received).not.toContain('event: ')
            const dataLine = received.split('\n').find((line) => line.startsWith('data: '))!
            const frame = JSON.parse(dataLine.slice('data: '.length))
            expect(frame.type).toBe(ExecutionEventType.ExecutionStarted)
            expect(frame.executionId).toBe(execution.id)

            stream.destroy()
        })

        it('replays events emitted while disconnected once the client reconnects with Last-Event-ID', async () => {
            const ctx = await createTestContext(app!)
            const execution = await saveExecutionRow(ctx, 'Resumable execution')

            const firstConnection = await ctx.inject({
                method: 'GET',
                url: `/api/v1/executions/${execution.id}/events`,
                payloadAsStream: true,
            })
            expect(firstConnection.statusCode).toBe(StatusCodes.OK)

            let receivedFirst = ''
            const firstStream = firstConnection.stream()
            firstStream.on('data', (chunk: Buffer) => {
                receivedFirst += chunk.toString()
            })

            const startedEvent = await executionEventService.emit({
                executionId: execution.id,
                type: ExecutionEventType.ExecutionStarted,
                payload: { executionId: execution.id, prompt: 'Resumable execution', timestamp: new Date().toISOString() },
            })

            await waitUntil(() => receivedFirst.includes(startedEvent.id))

            // Simulate the app replica serving this connection going away mid-stream —
            // a rescale, a rolling deploy, a killed pod — before the run finishes.
            firstStream.destroy()

            const completedEvent = await executionEventService.emit({
                executionId: execution.id,
                type: ExecutionEventType.ExecutionCompleted,
                payload: { executionId: execution.id, output: { success: true } },
            })

            // The client (or a different app replica) reconnects with the last id it saw,
            // simulating native EventSource auto-reconnect behavior.
            const secondConnection = await ctx.inject({
                method: 'GET',
                url: `/api/v1/executions/${execution.id}/events`,
                headers: { 'last-event-id': startedEvent.id },
                payloadAsStream: true,
            })
            expect(secondConnection.statusCode).toBe(StatusCodes.OK)

            let receivedSecond = ''
            const secondStream = secondConnection.stream()
            secondStream.on('data', (chunk: Buffer) => {
                receivedSecond += chunk.toString()
            })

            await waitUntil(() => receivedSecond.includes(completedEvent.id))

            expect(receivedSecond).toContain(`id: ${completedEvent.id}`)
            expect(receivedSecond).not.toContain(`id: ${startedEvent.id}`)

            secondStream.destroy()
        })

        it('keeps remaining stream active when one concurrent SSE client disconnects (#158)', async () => {
            const ctx = await createTestContext(app!)
            const execution = await saveExecutionRow(ctx, 'Multi-viewer execution')

            // Connect Viewer 1
            const firstConnection = await ctx.inject({
                method: 'GET',
                url: `/api/v1/executions/${execution.id}/events`,
                payloadAsStream: true,
            })
            expect(firstConnection.statusCode).toBe(StatusCodes.OK)
            let receivedFirst = ''
            const firstStream = firstConnection.stream()
            firstStream.on('data', (chunk: Buffer) => {
                receivedFirst += chunk.toString()
            })

            // Connect Viewer 2
            const secondConnection = await ctx.inject({
                method: 'GET',
                url: `/api/v1/executions/${execution.id}/events`,
                payloadAsStream: true,
            })
            expect(secondConnection.statusCode).toBe(StatusCodes.OK)
            let receivedSecond = ''
            const secondStream = secondConnection.stream()
            secondStream.on('data', (chunk: Buffer) => {
                receivedSecond += chunk.toString()
            })

            // Emit Event 1 (both should receive)
            const event1 = await executionEventService.emit({
                executionId: execution.id,
                type: ExecutionEventType.ExecutionStarted,
                payload: { executionId: execution.id, prompt: 'Multi-viewer execution', timestamp: new Date().toISOString() },
            })

            await waitUntil(() => receivedFirst.includes(event1.id) && receivedSecond.includes(event1.id))
            expect((receivedFirst.match(new RegExp(`id: ${event1.id}`, 'g')) || []).length).toBe(1)
            expect((receivedSecond.match(new RegExp(`id: ${event1.id}`, 'g')) || []).length).toBe(1)

            // Disconnect Viewer 1 (simulating closing one browser tab)
            firstStream.destroy()

            // Emit Event 2
            const event2 = await executionEventService.emit({
                executionId: execution.id,
                type: ExecutionEventType.ExecutionCompleted,
                payload: { executionId: execution.id, output: { success: true } },
            })

            // Viewer 2 must STILL receive Event 2 exactly once!
            await waitUntil(() => receivedSecond.includes(event2.id))
            expect((receivedSecond.match(new RegExp(`id: ${event2.id}`, 'g')) || []).length).toBe(1)

            secondStream.destroy()
        })

        it('delivers events exactly once after a close-last-viewer and reconnect cycle (#158)', async () => {
            const ctx = await createTestContext(app!)
            const execution = await saveExecutionRow(ctx, 'Reconnect execution')

            // Connect Viewer 1
            const firstConnection = await ctx.inject({
                method: 'GET',
                url: `/api/v1/executions/${execution.id}/events`,
                payloadAsStream: true,
            })
            expect(firstConnection.statusCode).toBe(StatusCodes.OK)
            let receivedFirst = ''
            const firstStream = firstConnection.stream()
            firstStream.on('data', (chunk: Buffer) => {
                receivedFirst += chunk.toString()
            })

            const event1 = await executionEventService.emit({
                executionId: execution.id,
                type: ExecutionEventType.ExecutionStarted,
                payload: { executionId: execution.id, prompt: 'Initial prompt' },
            })

            await waitUntil(() => receivedFirst.includes(event1.id))
            expect((receivedFirst.match(new RegExp(`id: ${event1.id}`, 'g')) || []).length).toBe(1)

            // Close Viewer 1 (last viewer closes, dropping channel to 0 listeners)
            firstStream.destroy()

            // Connect Viewer 2 (reconnect to the same execution)
            const secondConnection = await ctx.inject({
                method: 'GET',
                url: `/api/v1/executions/${execution.id}/events`,
                headers: { 'last-event-id': event1.id },
                payloadAsStream: true,
            })
            expect(secondConnection.statusCode).toBe(StatusCodes.OK)
            let receivedSecond = ''
            const secondStream = secondConnection.stream()
            secondStream.on('data', (chunk: Buffer) => {
                receivedSecond += chunk.toString()
            })

            // Emit Event 2
            const event2 = await executionEventService.emit({
                executionId: execution.id,
                type: ExecutionEventType.ExecutionCompleted,
                payload: { executionId: execution.id, output: { ok: true } },
            })

            await waitUntil(() => receivedSecond.includes(event2.id))

            // Assert that Event 2 is delivered exactly once to Viewer 2
            expect((receivedSecond.match(new RegExp(`id: ${event2.id}`, 'g')) || []).length).toBe(1)

            secondStream.destroy()
        })

        it('denies streaming an execution owned by another project', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)
            const execution = await saveExecutionRow(ctxA, 'Project A only')

            const response = await ctxB.get(`/v1/executions/${execution.id}/events`)

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })

    describe('GET /v1/executions (list)', () => {
        it('requires projectId and scopes results to it', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)
            await saveExecutionRow(ctxA, 'A one')
            await saveExecutionRow(ctxB, 'B one')

            const withoutProject = await ctxA.get('/v1/executions')
            expect(withoutProject?.statusCode).toBe(StatusCodes.FORBIDDEN)

            const scoped = await ctxA.get('/v1/executions', { projectId: ctxA.project.id })
            expect(scoped?.statusCode).toBe(StatusCodes.OK)
            const body = scoped!.json()
            expect(body.data).toHaveLength(1)
            expect(body.data[0].prompt).toBe('A one')
            expect(body.next).toBeNull()
            expect(body.previous).toBeNull()
        })

        it('denies listing another project executions', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)

            const response = await ctxB.get('/v1/executions', { projectId: ctxA.project.id })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('paginates executions using cursor and limit (#156)', async () => {
            const ctx = await createTestContext(app!)
            await saveExecutionRow(ctx, 'Prompt 1', { created: '2026-01-01T10:00:10.000Z' })
            await saveExecutionRow(ctx, 'Prompt 2', { created: '2026-01-01T10:00:20.000Z' })
            await saveExecutionRow(ctx, 'Prompt 3', { created: '2026-01-01T10:00:30.000Z' })

            // Page 1: newest 2 (Prompt 3 and Prompt 2)
            const page1Res = await ctx.get('/v1/executions', { projectId: ctx.project.id, limit: 2 })
            expect(page1Res?.statusCode).toBe(StatusCodes.OK)
            const page1 = page1Res!.json()
            expect(page1.data).toHaveLength(2)
            expect(page1.data[0].prompt).toBe('Prompt 3')
            expect(page1.data[1].prompt).toBe('Prompt 2')
            expect(page1.next).toBeTruthy()
            expect(page1.previous).toBeNull()

            // Page 2: remaining 1 (Prompt 1) using next cursor
            const page2Res = await ctx.get('/v1/executions', { projectId: ctx.project.id, limit: 2, cursor: page1.next })
            expect(page2Res?.statusCode).toBe(StatusCodes.OK)
            const page2 = page2Res!.json()
            expect(page2.data).toHaveLength(1)
            expect(page2.data[0].prompt).toBe('Prompt 1')
            expect(page2.next).toBeNull()
            expect(page2.previous).toBeTruthy()
        })

        it('combines status filter with cursor pagination (#156)', async () => {
            const ctx = await createTestContext(app!)
            await saveExecutionRow(ctx, 'Completed 1', {
                created: '2026-01-01T11:00:10.000Z',
                status: ExecutionStatus.COMPLETED,
            })
            await saveExecutionRow(ctx, 'Failed 1', {
                created: '2026-01-01T11:00:20.000Z',
                status: ExecutionStatus.FAILED,
            })
            await saveExecutionRow(ctx, 'Completed 2', {
                created: '2026-01-01T11:00:30.000Z',
                status: ExecutionStatus.COMPLETED,
            })

            // Fetch COMPLETED with limit 1
            const page1Res = await ctx.get('/v1/executions', {
                projectId: ctx.project.id,
                status: ExecutionStatus.COMPLETED,
                limit: 1,
            })
            expect(page1Res?.statusCode).toBe(StatusCodes.OK)
            const page1 = page1Res!.json()
            expect(page1.data).toHaveLength(1)
            expect(page1.data[0].prompt).toBe('Completed 2')
            expect(page1.data[0].status).toBe(ExecutionStatus.COMPLETED)
            expect(page1.next).toBeTruthy()

            // Fetch next page of COMPLETED
            const page2Res = await ctx.get('/v1/executions', {
                projectId: ctx.project.id,
                status: ExecutionStatus.COMPLETED,
                limit: 1,
                cursor: page1.next,
            })
            expect(page2Res?.statusCode).toBe(StatusCodes.OK)
            const page2 = page2Res!.json()
            expect(page2.data).toHaveLength(1)
            expect(page2.data[0].prompt).toBe('Completed 1')
            expect(page2.data[0].status).toBe(ExecutionStatus.COMPLETED)
            expect(page2.next).toBeNull()
        })
    })
})

describe('Trigger binding authorization (USER principal, :id routes)', () => {
    it('reads its own trigger binding detail', async () => {
        const ctx = await createTestContext(app!)
        const binding = await saveTriggerBindingRow(ctx)

        const response = await ctx.get(`/v1/trigger-bindings/${binding.id}`)

        expect(response?.statusCode, response?.payload).toBe(StatusCodes.OK)
        expect(response!.json().id).toBe(binding.id)
    })

    it('denies reading a trigger binding of another project', async () => {
        const ctxA = await createTestContext(app!)
        const ctxB = await createTestContext(app!)
        const binding = await saveTriggerBindingRow(ctxA)

        const response = await ctxB.get(`/v1/trigger-bindings/${binding.id}`)

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('denies mutating a trigger binding of another project', async () => {
        const ctxA = await createTestContext(app!)
        const ctxB = await createTestContext(app!)
        const binding = await saveTriggerBindingRow(ctxA)

        const disable = await ctxB.post(`/v1/trigger-bindings/${binding.id}/disable`)
        expect(disable?.statusCode).toBe(StatusCodes.FORBIDDEN)

        const removed = await ctxB.delete(`/v1/trigger-bindings/${binding.id}`)
        expect(removed?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})

describe('Scheduled task authorization (USER principal, :id routes)', () => {
    it('reads its own scheduled task detail', async () => {
        const ctx = await createTestContext(app!)
        const task = await saveScheduledTaskRow(ctx)

        const response = await ctx.get(`/v1/scheduled-tasks/${task.id}`)

        expect(response?.statusCode, response?.payload).toBe(StatusCodes.OK)
        expect(response!.json().id).toBe(task.id)
    })

    it('denies reading a scheduled task of another project', async () => {
        const ctxA = await createTestContext(app!)
        const ctxB = await createTestContext(app!)
        const task = await saveScheduledTaskRow(ctxA)

        const response = await ctxB.get(`/v1/scheduled-tasks/${task.id}`)

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('denies deleting a scheduled task of another project', async () => {
        const ctxA = await createTestContext(app!)
        const ctxB = await createTestContext(app!)
        const task = await saveScheduledTaskRow(ctxA)

        const response = await ctxB.delete(`/v1/scheduled-tasks/${task.id}`)

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})

describe('POST /v1/execute authorization (direct tool run)', () => {
    it('accepts the target project from the request body', async () => {
        const ctx = await createTestContext(app!)

        const response = await ctx.post('/v1/execute', {
            projectId: ctx.project.id,
            integration: '@inboxfm-connect/piece-does-not-exist',
            tool: 'noop',
            connectionId: apId(),
            input: {},
        })

        // The runtime will fail on the unknown piece; what matters here is that
        // authorization resolved the project instead of rejecting the principal.
        expect(response?.statusCode).not.toBe(StatusCodes.FORBIDDEN)
    })

    it('denies executing against another project', async () => {
        const ctxA = await createTestContext(app!)
        const ctxB = await createTestContext(app!)

        const response = await ctxB.post('/v1/execute', {
            projectId: ctxA.project.id,
            integration: '@inboxfm-connect/piece-does-not-exist',
            tool: 'noop',
            connectionId: apId(),
            input: {},
        })

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})

describe('Automation list/create authorization (projectId is mandatory)', () => {
    it('rejects a trigger binding list without projectId and accepts it with one', async () => {
        const ctx = await createTestContext(app!)
        await saveTriggerBindingRow(ctx)

        const withoutProject = await ctx.get('/v1/trigger-bindings')
        expect(withoutProject?.statusCode).toBe(StatusCodes.FORBIDDEN)

        const scoped = await ctx.get('/v1/trigger-bindings', { projectId: ctx.project.id })
        expect(scoped?.statusCode).toBe(StatusCodes.OK)
        expect(scoped!.json().data).toHaveLength(1)
    })

    it('rejects a scheduled task list without projectId and accepts it with one', async () => {
        const ctx = await createTestContext(app!)
        await saveScheduledTaskRow(ctx)

        const withoutProject = await ctx.get('/v1/scheduled-tasks')
        expect(withoutProject?.statusCode).toBe(StatusCodes.FORBIDDEN)

        const scoped = await ctx.get('/v1/scheduled-tasks', { projectId: ctx.project.id })
        expect(scoped?.statusCode).toBe(StatusCodes.OK)
        expect(scoped!.json().data).toHaveLength(1)
    })

    it('rejects a trigger binding create without projectId in the body', async () => {
        const ctx = await createTestContext(app!)

        const response = await ctx.post('/v1/trigger-bindings', {
            pieceName: '@inboxfm-connect/piece-webhook',
            pieceVersion: '0.1.0',
            triggerName: 'catch_webhook',
            promptTemplate: 'Handle {{item}}',
            settings: {},
        })

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('rejects a scheduled task create without projectId in the body', async () => {
        const ctx = await createTestContext(app!)

        const response = await ctx.post('/v1/scheduled-tasks', {
            prompt: 'Daily summary',
            cronExpression: '0 8 * * *',
            timezone: 'UTC',
        })

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('denies creating a trigger binding in another project', async () => {
        const ctxA = await createTestContext(app!)
        const ctxB = await createTestContext(app!)

        const response = await ctxB.post('/v1/trigger-bindings', {
            projectId: ctxA.project.id,
            pieceName: '@inboxfm-connect/piece-webhook',
            pieceVersion: '0.1.0',
            triggerName: 'catch_webhook',
            promptTemplate: 'Handle {{item}}',
            settings: {},
        })

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})
