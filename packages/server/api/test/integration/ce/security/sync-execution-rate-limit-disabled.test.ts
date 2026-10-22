import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { redisConnections } from '../../../../src/app/database/redis-connections'

// AP_API_RATE_LIMIT_SYNC_ENABLED=false must disable the sync tier even while
// the AUTHN tier keeps the shared plugin registered. The tier flag is read
// eagerly at module load (core/security/rate-limit.ts), so this file sets the
// env var and then dynamically imports the app bootstrap — static imports
// would hoist above the assignment and read the wrong value. Vitest isolates
// modules per test file, so no other suite observes this override.
process.env.AP_API_RATE_LIMIT_SYNC_ENABLED = 'false'

let app: FastifyInstance | null = null

beforeAll(async () => {
    const { setupTestEnvironment } = await import('../../../helpers/test-setup')
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    const { teardownTestEnvironment } = await import('../../../helpers/test-setup')
    await teardownTestEnvironment()
    delete process.env.AP_API_RATE_LIMIT_SYNC_ENABLED
})

afterEach(async () => {
    vi.restoreAllMocks()
    const redis = await redisConnections.useExisting()
    await redis.flushall()
})

describe('Sync-execution rate-limit tier off-switch', () => {
    it('leaves sync routes unthrottled when disabled, with AUTHN tier still on', async () => {
        const { createTestContext } = await import('../../../helpers/test-context')
        const ctx = await createTestContext(app!)

        const ip = '198.51.100.40'
        for (let i = 0; i < 65; i++) {
            const response = await ctx.inject({
                method: 'GET',
                url: '/api/v1/executions',
                query: { projectId: ctx.project.id },
                headers: { 'x-real-ip': ip },
            })
            expect(response.statusCode).toBe(StatusCodes.OK)
        }
    })
})
