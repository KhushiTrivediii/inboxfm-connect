import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

const SYNC_IP_MAX = Number.parseInt(system.getOrThrow(AppSystemProp.API_RATE_LIMIT_SYNC_MAX), 10)

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

afterEach(async () => {
    vi.restoreAllMocks()
    const redis = await redisConnections.useExisting()
    await redis.flushall()
})

describe('Sync-execution rate-limit tier (#164)', () => {
    let ctx: TestContext

    beforeEach(async () => {
        ctx = await createTestContext(app!)
    })

    it('allows executions list up to the limit, then returns 429 with Retry-After', async () => {
        const ip = '198.51.100.30'

        for (let i = 0; i < SYNC_IP_MAX; i++) {
            const response = await ctx.inject({
                method: 'GET',
                url: '/api/v1/executions',
                query: { projectId: ctx.project.id },
                headers: { 'x-real-ip': ip },
            })
            expect(response.statusCode).toBe(StatusCodes.OK)
        }

        const throttled = await ctx.inject({
            method: 'GET',
            url: '/api/v1/executions',
            query: { projectId: ctx.project.id },
            headers: { 'x-real-ip': ip },
        })
        expect(throttled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)
        expect(throttled.headers['retry-after']).toBeDefined()
    })

    it('isolates different client IPs so throttling one does not impact another', async () => {
        const throttledIp = '198.51.100.40'
        const separateIp = '198.51.100.41'

        for (let i = 0; i < SYNC_IP_MAX; i++) {
            await ctx.inject({
                method: 'GET',
                url: '/api/v1/executions',
                query: { projectId: ctx.project.id },
                headers: { 'x-real-ip': throttledIp },
            })
        }

        const throttled = await ctx.inject({
            method: 'GET',
            url: '/api/v1/executions',
            query: { projectId: ctx.project.id },
            headers: { 'x-real-ip': throttledIp },
        })
        expect(throttled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)

        // Separate IP must still succeed immediately
        const freshResponse = await ctx.inject({
            method: 'GET',
            url: '/api/v1/executions',
            query: { projectId: ctx.project.id },
            headers: { 'x-real-ip': separateIp },
        })
        expect(freshResponse.statusCode).toBe(StatusCodes.OK)
    })

    it('burst load test demonstrates no degradation under normal traffic', async () => {
        const burstIp = '198.51.100.50'
        const burstSize = 20

        const burstPromises = Array.from({ length: burstSize }, () =>
            ctx.inject({
                method: 'GET',
                url: '/api/v1/executions',
                query: { projectId: ctx.project.id },
                headers: { 'x-real-ip': burstIp },
            }),
        )

        const results = await Promise.all(burstPromises)

        expect(results).toHaveLength(burstSize)
        for (const res of results) {
            expect(res.statusCode).toBe(StatusCodes.OK)
            const body = JSON.parse(res.body)
            expect(body.data).toBeDefined()
        }
    })

    it('falls back to request.ip when x-real-ip header is omitted or empty', async () => {
        for (let i = 0; i < SYNC_IP_MAX; i++) {
            const res = await ctx.inject({
                method: 'GET',
                url: '/api/v1/executions',
                query: { projectId: ctx.project.id },
            })
            expect(res.statusCode).toBe(StatusCodes.OK)
        }

        const throttled = await ctx.inject({
            method: 'GET',
            url: '/api/v1/executions',
            query: { projectId: ctx.project.id },
        })
        expect(throttled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)
        expect(throttled.headers['retry-after']).toBeDefined()
    })

    it('disables sync rate limiting when API_RATE_LIMIT_SYNC_ENABLED is false', async () => {
        const ip = '198.51.100.60'
        const originalGetBoolean = system.getBoolean.bind(system)
        vi.spyOn(system, 'getBoolean').mockImplementation((prop: string) => {
            if (prop === AppSystemProp.API_RATE_LIMIT_SYNC_ENABLED) {
                return false
            }
            return originalGetBoolean(prop as AppSystemProp)
        })

        for (let i = 0; i < SYNC_IP_MAX + 5; i++) {
            const res = await ctx.inject({
                method: 'GET',
                url: '/api/v1/executions',
                query: { projectId: ctx.project.id },
                headers: { 'x-real-ip': ip },
            })
            expect(res.statusCode).toBe(StatusCodes.OK)
        }
    })

    it('applies sync rate limit to POST /v1/execute', async () => {
        const ip = '198.51.100.70'

        for (let i = 0; i < SYNC_IP_MAX; i++) {
            const res = await ctx.inject({
                method: 'POST',
                url: '/api/v1/execute',
                headers: { 'x-real-ip': ip },
                body: {
                    pieceName: '@inboxfm-connect/piece-slack',
                    pieceVersion: '0.4.1',
                    actionName: 'send_message',
                    input: {},
                    projectId: ctx.project.id,
                },
            })
            expect(res.statusCode).not.toBe(StatusCodes.TOO_MANY_REQUESTS)
        }

        const throttled = await ctx.inject({
            method: 'POST',
            url: '/api/v1/execute',
            headers: { 'x-real-ip': ip },
            body: {
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '0.4.1',
                actionName: 'send_message',
                input: {},
                projectId: ctx.project.id,
            },
        })
        expect(throttled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)
        expect(throttled.headers['retry-after']).toBeDefined()
    })

    it('applies sync rate limit to AI provider routes', async () => {
        const ip = '198.51.100.80'

        for (let i = 0; i < SYNC_IP_MAX; i++) {
            const res = await ctx.inject({
                method: 'GET',
                url: '/api/v1/ai-providers',
                query: { projectId: ctx.project.id },
                headers: { 'x-real-ip': ip },
            })
            expect(res.statusCode).toBe(StatusCodes.OK)
        }

        const throttled = await ctx.inject({
            method: 'GET',
            url: '/api/v1/ai-providers',
            query: { projectId: ctx.project.id },
            headers: { 'x-real-ip': ip },
        })
        expect(throttled.statusCode).toBe(StatusCodes.TOO_MANY_REQUESTS)
        expect(throttled.headers['retry-after']).toBeDefined()
    })
})

