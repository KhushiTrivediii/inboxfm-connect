import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    if (app !== null) {
        ctx = await createTestContext(app)
    }
})

describe('License keys API edition gating', () => {
    it('should not register the license-keys routes in the community edition', async () => {
        const verify = await ctx.post('/v1/license-keys/verify', {
            platformId: 'irrelevant-platform-id',
            licenseKey: 'irrelevant-license-key',
        })

        expect(verify?.statusCode).toBe(StatusCodes.NOT_FOUND)

        const getKey = await ctx.get('/v1/license-keys/some-license-key')

        expect(getKey?.statusCode).toBe(StatusCodes.NOT_FOUND)
    })
})
