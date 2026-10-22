import { AnalyticsTimePeriod, PlatformRole } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Platform Analytics API (EE)', () => {
    describe('Feature Gating', () => {
        it('should return 402 FEATURE_DISABLED when analyticsEnabled is false or omitted in plan', async () => {
            const ctx = await createTestContext(app!, {
                plan: {
                    analyticsEnabled: false,
                },
            })

            const resGet = await ctx.get('/v1/analytics')
            expect(resGet.statusCode).toBe(StatusCodes.PAYMENT_REQUIRED)

            const resRefresh = await ctx.post('/v1/analytics/refresh', {})
            expect(resRefresh.statusCode).toBe(StatusCodes.PAYMENT_REQUIRED)

            const resMark = await ctx.post('/v1/analytics/mark-outdated', {})
            expect(resMark.statusCode).toBe(StatusCodes.PAYMENT_REQUIRED)
        })
    })

    describe('Report Lifecycle with analyticsEnabled = true', () => {
        it('should generate and fetch analytics report on first GET request', async () => {
            const ctx = await createTestContext(app!, {
                plan: {
                    analyticsEnabled: true,
                },
            })

            const res = await ctx.get('/v1/analytics')
            expect(res.statusCode).toBe(StatusCodes.OK)

            const body = res.json()
            expect(body).toHaveProperty('id')
            expect(body.platformId).toBe(ctx.platform.id)
            expect(body.outdated).toBe(false)
            expect(Array.isArray(body.runs)).toBe(true)
            expect(Array.isArray(body.flows)).toBe(true)
            expect(Array.isArray(body.users)).toBe(true)
            expect(body.users.length).toBeGreaterThan(0)
            expect(body.users[0].id).toBe(ctx.user.id)
            expect(body.users[0].email).toBe(ctx.userIdentity.email)
            expect(body.users[0].platformRole).toBe(PlatformRole.ADMIN)
        })

        it('should filter report by time period when query param is supplied', async () => {
            const ctx = await createTestContext(app!, {
                plan: {
                    analyticsEnabled: true,
                },
            })

            const resWeek = await ctx.get(`/v1/analytics?timePeriod=${AnalyticsTimePeriod.LAST_WEEK}`)
            expect(resWeek.statusCode).toBe(StatusCodes.OK)
            const bodyWeek = resWeek.json()
            expect(bodyWeek.platformId).toBe(ctx.platform.id)
            expect(Array.isArray(bodyWeek.runs)).toBe(true)

            const resMonth = await ctx.get(`/v1/analytics?timePeriod=${AnalyticsTimePeriod.LAST_MONTH}`)
            expect(resMonth.statusCode).toBe(StatusCodes.OK)
        })

        it('should mark report as outdated via POST /v1/analytics/mark-outdated', async () => {
            const ctx = await createTestContext(app!, {
                plan: {
                    analyticsEnabled: true,
                },
            })

            // Fetch to ensure report is created
            await ctx.get('/v1/analytics')

            // Mark as outdated
            const resMark = await ctx.post('/v1/analytics/mark-outdated', {})
            expect(resMark.statusCode).toBe(StatusCodes.OK)
        })

        it('should refresh report via POST /v1/analytics/refresh', async () => {
            const ctx = await createTestContext(app!, {
                plan: {
                    analyticsEnabled: true,
                },
            })

            const resRefresh = await ctx.post('/v1/analytics/refresh', {})
            expect(resRefresh.statusCode).toBe(StatusCodes.OK)

            const body = resRefresh.json()
            expect(body.platformId).toBe(ctx.platform.id)
            expect(body.outdated).toBe(false)
            expect(body.users.length).toBeGreaterThan(0)
        })

        it('should isolate analytics reports between different platforms', async () => {
            const ctxA = await createTestContext(app!, {
                plan: {
                    analyticsEnabled: true,
                },
            })

            const ctxB = await createTestContext(app!, {
                plan: {
                    analyticsEnabled: true,
                },
            })

            const resA = await ctxA.get('/v1/analytics')
            const resB = await ctxB.get('/v1/analytics')

            expect(resA.statusCode).toBe(StatusCodes.OK)
            expect(resB.statusCode).toBe(StatusCodes.OK)

            const bodyA = resA.json()
            const bodyB = resB.json()

            expect(bodyA.platformId).toBe(ctxA.platform.id)
            expect(bodyB.platformId).toBe(ctxB.platform.id)
            expect(bodyA.id).not.toBe(bodyB.id)
        })
    })
})
