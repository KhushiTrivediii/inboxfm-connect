import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

/**
 * Guard coverage for POST /v1/execute (Issue #136, partial).
 *
 * Deliberately stops at the authorization/validation boundary: actually
 * running a tool needs live third-party credentials, which no test may
 * invent (see developer-console-smoke.test.ts). Happy-path execution with a
 * real fixture and concurrent-duplicate dedup remain open until a
 * credential-free local piece can run in-process.
 */
let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

afterEach(async () => {
    vi.restoreAllMocks()
})

describe('POST /v1/execute entrypoint guards (Issue #136)', () => {
    let ctx: TestContext

    beforeEach(async () => {
        ctx = await createTestContext(app!)
    })

    it('rejects unauthenticated calls with 403', async () => {
        const response = await app!.inject({
            method: 'POST',
            url: '/api/v1/execute',
            payload: {
                projectId: ctx.project.id,
                integration: '@inboxfm-connect/piece-slack',
                tool: 'send_message',
                connectionId: 'conn_missing',
                input: {},
            },
        })

        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('rejects a call with neither connectionId nor externalUserId', async () => {
        const response = await ctx.post('/v1/execute', {
            projectId: ctx.project.id,
            integration: '@inboxfm-connect/piece-slack',
            tool: 'send_message',
            input: {},
        })

        expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        expect(response?.json().code).toBe('VALIDATION')
    })

    it('returns 404 for an unknown externalUserId', async () => {
        const response = await ctx.post('/v1/execute', {
            projectId: ctx.project.id,
            integration: '@inboxfm-connect/piece-slack',
            tool: 'send_message',
            externalUserId: 'ghost-customer-with-no-connection',
            input: {},
        })

        expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
    })

    it('rejects a call with missing projectId', async () => {
        const response = await ctx.post('/v1/execute', {
            integration: '@inboxfm-connect/piece-slack',
            tool: 'send_message',
            connectionId: 'conn_missing',
            input: {},
        })

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('rejects a call with unknown projectId with 404', async () => {
        const response = await ctx.post('/v1/execute', {
            projectId: 'proj_unknown_12345',
            integration: '@inboxfm-connect/piece-slack',
            tool: 'send_message',
            connectionId: 'conn_missing',
            input: {},
        })

        expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
    })
})
