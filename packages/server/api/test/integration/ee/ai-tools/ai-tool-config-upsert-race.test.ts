import { AiToolCapability, AiToolProvider } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { EntityManager } from 'typeorm'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// Deterministic interleave: Repository.findOneBy delegates to
// EntityManager.findOneBy on the shared connection, so a prototype spy that
// filters on the ai_tool_config where-clause (the capability field) can park
// the first request's find until the second request's find arrives — the
// exact find-then-save overlap two concurrent first configurations hit.
async function withParkedCapabilityFinds<T>(fn: () => Promise<T>): Promise<T> {
    const original = EntityManager.prototype.findOneBy
    let capabilityFinds = 0
    let releaseFirst: () => void = () => { }
    const secondFindArrived = new Promise<void>((resolve) => {
        releaseFirst = resolve
    })
    try {
        EntityManager.prototype.findOneBy = async function (target: unknown, where: Record<string, unknown>) {
            if (where && where.capability !== undefined) {
                capabilityFinds++
                if (capabilityFinds === 1) {
                    // park the first request at its read until the second one reads
                    await secondFindArrived
                }
                else {
                    releaseFirst()
                }
                return null
            }
            return original.call(this, target, where)
        } as unknown as typeof EntityManager.prototype.findOneBy
        return await fn()
    }
    finally {
        EntityManager.prototype.findOneBy = original
    }
}

describe('AI Tools API - concurrent first configuration race', () => {
    it('concurrent first POSTs for the same capability both succeed and leave exactly one row', async () => {
        // arrange
        const ctx = await createTestContext(app!)

        // act — both requests are parked so each reads `existing = null` before
        // either write lands. Pre-fix, both then save a fresh row and the
        // loser violates idx_ai_tool_config_platform_capability: raw driver
        // error surfaced to a platform-admin settings route.
        const [response1, response2] = await withParkedCapabilityFinds(() => Promise.all([
            ctx.post('/v1/ai-tools', {
                capability: AiToolCapability.WEB_SEARCH,
                provider: AiToolProvider.TAVILY,
                auth: { apiKey: 'race-probe-tavily-key' },
                enabled: true,
            }),
            ctx.post('/v1/ai-tools', {
                capability: AiToolCapability.WEB_SEARCH,
                provider: AiToolProvider.TAVILY,
                auth: { apiKey: 'race-probe-tavily-key' },
                enabled: true,
            }),
        ]))

        // assert
        expect(response1?.statusCode).toBe(StatusCodes.OK)
        expect(response2?.statusCode).toBe(StatusCodes.OK)

        const rows = await databaseConnection().getRepository('ai_tool_config').find({
            where: {
                platformId: ctx.platform.id,
                capability: AiToolCapability.WEB_SEARCH,
            },
        })
        expect(rows).toHaveLength(1)
        expect(rows[0].provider).toBe(AiToolProvider.TAVILY)
    })

    it('high-concurrency first configuration converges on one row', async () => {
        // arrange
        const ctx = await createTestContext(app!)

        // act — five simultaneous first-time configurations through the real
        // route; the unique index must never surface a failure
        const responses = await Promise.all(
            Array.from({ length: 5 }, () =>
                ctx.post('/v1/ai-tools', {
                    capability: AiToolCapability.WEB_SCRAPING,
                    provider: AiToolProvider.FIRECRAWL,
                    auth: { apiKey: 'race-probe-firecrawl-key' },
                    enabled: true,
                }),
            ),
        )

        // assert
        const codes = responses.map((r) => r?.statusCode)
        expect(codes.filter((code) => code === StatusCodes.OK)).toHaveLength(5)

        const rows = await databaseConnection().getRepository('ai_tool_config').find({
            where: {
                platformId: ctx.platform.id,
                capability: AiToolCapability.WEB_SCRAPING,
            },
        })
        expect(rows).toHaveLength(1)
    })

    it('sequential re-configuration still replaces the row values in place', async () => {
        // arrange — guards the DO UPDATE branch: the second POST must update the
        // winner row's provider/auth/enabled without duplicating or rotating it
        const ctx = await createTestContext(app!)

        // act
        const first = await ctx.post('/v1/ai-tools', {
            capability: AiToolCapability.IMAGE_GENERATION,
            provider: AiToolProvider.FAL,
            auth: { apiKey: 'race-probe-fal-key' },
        })
        expect(first?.statusCode).toBe(StatusCodes.OK)

        const second = await ctx.post('/v1/ai-tools', {
            capability: AiToolCapability.IMAGE_GENERATION,
            provider: AiToolProvider.FAL,
            auth: { apiKey: 'race-probe-fal-key-2' },
            enabled: true,
        })
        expect(second?.statusCode).toBe(StatusCodes.OK)

        // assert
        const rows = await databaseConnection().getRepository('ai_tool_config').find({
            where: {
                platformId: ctx.platform.id,
                capability: AiToolCapability.IMAGE_GENERATION,
            },
        })
        expect(rows).toHaveLength(1)
        expect(rows[0].enabled).toBe(true)
        expect(rows[0].auth).not.toBeNull()
    })

    it('re-posting without a config keeps the stored provider config (update() parity)', async () => {
        // arrange — codeant round: the DO UPDATE column set must not include
        // `config` when the request omits it, or EXCLUDED.config (null) would
        // erase the stored provider configuration on a plain re-post
        const ctx = await createTestContext(app!)

        const first = await ctx.post('/v1/ai-tools', {
            capability: AiToolCapability.WEB_SEARCH,
            provider: AiToolProvider.TAVILY,
            auth: { apiKey: 'race-probe-tavily-key' },
            config: { maxResults: 10 },
        })
        expect(first?.statusCode).toBe(StatusCodes.OK)

        // act — re-post WITHOUT config (an admin flipping enabled from the
        // settings screen without re-entering provider options)
        const second = await ctx.post('/v1/ai-tools', {
            capability: AiToolCapability.WEB_SEARCH,
            provider: AiToolProvider.TAVILY,
            auth: { apiKey: 'race-probe-tavily-key' },
            enabled: false,
        })
        expect(second?.statusCode).toBe(StatusCodes.OK)

        // assert — stored config survives
        const rows = await databaseConnection().getRepository('ai_tool_config').find({
            where: {
                platformId: ctx.platform.id,
                capability: AiToolCapability.WEB_SEARCH,
            },
        })
        expect(rows).toHaveLength(1)
        expect(rows[0].config).toEqual({ maxResults: 10 })
        expect(rows[0].enabled).toBe(false)
    })
})
