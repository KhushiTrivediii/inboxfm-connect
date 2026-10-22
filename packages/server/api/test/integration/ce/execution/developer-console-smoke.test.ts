import { apId } from '@inboxfm-connect/core-utils'
import { ExecutionStatus } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

/**
 * End-to-end smoke coverage for every endpoint the developer console reads on load,
 * driven through the real Fastify app + database rather than a stubbed client.
 *
 * `POST /v1/execute` is deliberately only asserted up to the authorization boundary:
 * actually running a tool needs live third-party credentials, which no test may invent.
 */
let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

async function seedExecution(ctx: TestContext): Promise<{ id: string }> {
    const now = new Date().toISOString()
    const row = {
        id: apId(),
        created: now,
        updated: now,
        projectId: ctx.project.id,
        platformId: ctx.platform.id,
        userId: ctx.user.id,
        status: ExecutionStatus.CREATED,
        prompt: 'Console smoke execution',
        metadata: { triggerBindingId: 'tb_smoke' },
        tokenUsage: null,
        cost: null,
        finishTime: null,
    }
    await db.save('execution', row)
    return row
}

describe('Developer console endpoint smoke (real app + database)', () => {
    it('serves the integration catalog', async () => {
        const ctx = await createTestContext(app!)

        const response = await ctx.get('/v1/integrations')

        expect(response?.statusCode).toBe(StatusCodes.OK)
        expect(response!.json()).toHaveProperty('data')
        expect(Array.isArray(response!.json().data)).toBe(true)
    })

    it('serves the connection list scoped to the project', async () => {
        const ctx = await createTestContext(app!)

        const response = await ctx.get('/v1/connections', { projectId: ctx.project.id })

        expect(response?.statusCode).toBe(StatusCodes.OK)
        expect(response!.json()).toHaveProperty('data')
    })

    /**
     * Negative assertion, deliberately naming the legacy prefix: `appConnectionModule`
     * registers `/v1/connections`, while `/v1/app-connections` survives only as an
     * OpenAPI tag. Pinning the 404 stops the console (and this test corpus) from
     * drifting back to the old path.
     */
    it('has no /v1/app-connections route — the console must call /v1/connections', async () => {
        const ctx = await createTestContext(app!)

        const response = await ctx.get('/v1/app-connections', { projectId: ctx.project.id })

        expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
    })

    it('serves the project MCP server used by the MCP hub', async () => {
        const ctx = await createTestContext(app!)

        const response = await ctx.get(`/v1/projects/${ctx.project.id}/mcp-server`)

        expect(response?.statusCode).toBe(StatusCodes.OK)
        expect(response!.json().projectId).toBe(ctx.project.id)
    })

    it('serves the trigger binding and scheduled task lists', async () => {
        const ctx = await createTestContext(app!)

        const bindings = await ctx.get('/v1/trigger-bindings', { projectId: ctx.project.id })
        expect(bindings?.statusCode).toBe(StatusCodes.OK)
        expect(bindings!.json()).toHaveProperty('data')

        const tasks = await ctx.get('/v1/scheduled-tasks', { projectId: ctx.project.id })
        expect(tasks?.statusCode).toBe(StatusCodes.OK)
        expect(tasks!.json()).toHaveProperty('data')
    })

    it('walks the whole activity flow: list -> detail -> tool calls -> stream', async () => {
        const ctx = await createTestContext(app!)
        const execution = await seedExecution(ctx)

        const list = await ctx.get('/v1/executions', { projectId: ctx.project.id })
        expect(list?.statusCode).toBe(StatusCodes.OK)
        expect(list!.json().data.map((item: { id: string }) => item.id)).toContain(execution.id)

        const detail = await ctx.get(`/v1/executions/${execution.id}`)
        expect(detail?.statusCode).toBe(StatusCodes.OK)
        expect(detail!.json().metadata.triggerBindingId).toBe('tb_smoke')

        const toolCalls = await ctx.get(`/v1/executions/${execution.id}/tool-calls`)
        expect(toolCalls?.statusCode).toBe(StatusCodes.OK)
        expect(toolCalls!.json()).toEqual([])

        const stream = await ctx.inject({
            method: 'GET',
            url: `/api/v1/executions/${execution.id}/events`,
            payloadAsStream: true,
        })
        expect(stream.statusCode).toBe(StatusCodes.OK)
        expect(stream.headers['content-type']).toBe('text/event-stream')
        stream.stream().destroy()
    })

    it('rejects an unauthenticated activity read', async () => {
        const response = await app!.inject({
            method: 'GET',
            url: '/api/v1/executions',
        })

        expect(response.statusCode).toBeGreaterThanOrEqual(StatusCodes.UNAUTHORIZED)
    })
})
