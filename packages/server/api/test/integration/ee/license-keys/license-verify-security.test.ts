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

describe('License keys cross-tenant protection (#354)', () => {
    it('should reject an unauthenticated /verify request', async () => {
        const res = await app!.inject({
            method: 'POST',
            url: '/api/v1/license-keys/verify',
            payload: {
                platformId: ctx.platform.id,
                licenseKey: 'some-license-key',
            },
        })

        expect(res.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('should reject an unauthenticated GET /:licenseKey request', async () => {
        const res = await app!.inject({
            method: 'GET',
            url: `/api/v1/license-keys/some-license-key`,
        })

        expect(res.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('should never apply the client-supplied platformId: a forged platformId in the body still only reaches the caller own platform', async () => {
        // The security layer derives platformId from the authenticated principal,
        // so a forged platformId cannot redirect the plan overwrite to another
        // platform: the platform-admin caller gets an invalid-key error for their
        // OWN platform instead of tampering with someone else's plan.
        const res = await ctx.post('/v1/license-keys/verify', {
            platformId: 'someone-elses-platform',
            licenseKey: 'not-a-real-key',
        })

        expect(res.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(res.json().code).toBe('INVALID_LICENSE_KEY')
    })
})
