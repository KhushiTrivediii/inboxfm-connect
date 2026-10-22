import { ActionBase, TriggerBase } from '@inboxfm-connect/pieces-framework'
import { apVersionUtil } from '@inboxfm-connect/server-utils'
import { PackageType, PieceType, TriggerStrategy, TriggerTestStrategy } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pieceListCache } from '../../../../src/app/pieces/metadata/piece-list-cache'
import { db } from '../../../helpers/db'
import { createMockPieceMetadata } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

function action(over: Pick<ActionBase, 'name' | 'displayName' | 'description'>): ActionBase {
    return { name: over.name, displayName: over.displayName, description: over.description, props: {}, requireAuth: true }
}

function trigger(over: Pick<TriggerBase, 'name' | 'displayName' | 'description'>): TriggerBase {
    return {
        name: over.name,
        displayName: over.displayName,
        description: over.description,
        props: {},
        requireAuth: true,
        type: TriggerStrategy.WEBHOOK,
        sampleData: {},
        testStrategy: TriggerTestStrategy.SIMULATION,
    }
}

async function seedCatalog(): Promise<void> {
    await db.save('integration_metadata', createMockPieceMetadata({
        name: '@inboxfm-connect/piece-slack',
        displayName: 'Slack',
        version: '1.0.0',
        pieceType: PieceType.OFFICIAL,
        packageType: PackageType.REGISTRY,
        actions: {
            send_channel_message: action({
                name: 'send_channel_message',
                displayName: 'Send Channel Message',
                description: 'Send a message to a Slack channel',
            }),
        },
        triggers: {
            new_message: trigger({
                name: 'new_message',
                displayName: 'New Message',
                description: 'Triggers when a new message is posted to a Slack channel',
            }),
        },
    }))
    await db.save('integration_metadata', createMockPieceMetadata({
        name: '@inboxfm-connect/piece-gmail',
        displayName: 'Gmail',
        version: '1.0.0',
        pieceType: PieceType.OFFICIAL,
        packageType: PackageType.REGISTRY,
        actions: {
            send_email: action({
                name: 'send_email',
                displayName: 'Send Email',
                description: 'Send an email via Gmail',
            }),
        },
        triggers: {},
    }))
}

type SearchResultItem = {
    pieceName: string
    objectKind: string
    name: string
    displayName: string
}

describe('Knowledge Search API Integration (POST /v1/knowledge-search/query)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
        app = await setupTestEnvironment()
        await seedCatalog()
    })

    afterAll(async () => {
        await teardownTestEnvironment()
    })

    it('rejects unauthenticated requests with 403 Forbidden', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/knowledge-search/query',
            payload: {
                query: 'slack',
            },
        })

        expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('rejects empty query with 400 validation error', async () => {
        const ctx = await createTestContext(app)
        const response = await ctx.post('/v1/knowledge-search/query', {
            query: '',
        })

        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('rejects invalid limit with 400 validation error', async () => {
        const ctx = await createTestContext(app)
        const response = await ctx.post('/v1/knowledge-search/query', {
            query: 'slack',
            limit: 0,
        })

        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('executes real query against catalog and returns 200 with matching results', async () => {
        const ctx = await createTestContext(app)
        const response = await ctx.post('/v1/knowledge-search/query', {
            query: 'slack',
        })

        expect(response?.statusCode).toBe(StatusCodes.OK)
        const body = response?.json()
        expect(body).toBeDefined()
        expect(Array.isArray(body.results)).toBe(true)
        expect(body.results.length).toBeGreaterThan(0)
        expect((body.results as SearchResultItem[]).some((r) => r.pieceName === '@inboxfm-connect/piece-slack')).toBe(true)
        expect(body.mode).toBe('keyword')
    })

    it('filters by objectKind and limits results on the real stack', async () => {
        const ctx = await createTestContext(app)
        const response = await ctx.post('/v1/knowledge-search/query', {
            query: 'slack',
            objectKind: 'action',
            limit: 1,
        })

        expect(response?.statusCode).toBe(StatusCodes.OK)
        const body = response?.json()
        expect(body.results.length).toBeLessThanOrEqual(1)
        if (body.results.length > 0) {
            expect(body.results[0].objectKind).toBe('action')
        }
    })

    it('filters by pieceName on real database stack, excluding other matching pieces', async () => {
        const ctx = await createTestContext(app)
        const response = await ctx.post('/v1/knowledge-search/query', {
            query: 'send',
            pieceName: '@inboxfm-connect/piece-slack',
        })

        expect(response?.statusCode).toBe(StatusCodes.OK)
        const body = response?.json()
        const results = body.results as SearchResultItem[]
        expect(results.length).toBeGreaterThan(0)
        expect(results.every((r) => r.pieceName === '@inboxfm-connect/piece-slack')).toBe(true)
        expect(results.some((r) => r.pieceName === '@inboxfm-connect/piece-gmail')).toBe(false)
    })

    it('returns empty results for non-existent piece on real database stack without failing', async () => {
        const ctx = await createTestContext(app)
        const response = await ctx.post('/v1/knowledge-search/query', {
            query: 'slack',
            pieceName: '@inboxfm-connect/piece-completely-non-existent-xyz-999',
        })

        expect(response?.statusCode).toBe(StatusCodes.OK)
        const body = response?.json()
        expect(body.results).toEqual([])
    })

    it('enforces multi-tenant context isolation across different platform callers', async () => {
        const ctx1 = await createTestContext(app)
        const ctx2 = await createTestContext(app)

        await db.save('integration_metadata', createMockPieceMetadata({
            name: '@acme/piece-internal-ctx1',
            displayName: 'Tenant One Internal',
            version: '1.0.0',
            platformId: ctx1.platform.id,
            pieceType: PieceType.CUSTOM,
            packageType: PackageType.REGISTRY,
            actions: {
                send_alert: action({
                    name: 'send_alert',
                    displayName: 'Tenant One Alert',
                    description: 'Internal tenant alert message',
                }),
            },
            triggers: {},
        }))

        await db.save('integration_metadata', createMockPieceMetadata({
            name: '@globex/piece-secret-ctx2',
            displayName: 'Tenant Two Secret',
            version: '1.0.0',
            platformId: ctx2.platform.id,
            pieceType: PieceType.CUSTOM,
            packageType: PackageType.REGISTRY,
            actions: {
                send_secret: action({
                    name: 'send_secret',
                    displayName: 'Tenant Two Secret Alert',
                    description: 'Secret tenant message',
                }),
            },
            triggers: {},
        }))

        await pieceListCache.invalidate(apVersionUtil.getCurrentRelease())

        const [res1, res2] = await Promise.all([
            ctx1.post('/v1/knowledge-search/query', { query: 'alert' }),
            ctx2.post('/v1/knowledge-search/query', { query: 'alert' }),
        ])

        expect(res1?.statusCode).toBe(StatusCodes.OK)
        expect(res2?.statusCode).toBe(StatusCodes.OK)

        const body1 = res1?.json()
        const body2 = res2?.json()

        const pieces1 = (body1.results as SearchResultItem[]).map((r) => r.pieceName)
        const pieces2 = (body2.results as SearchResultItem[]).map((r) => r.pieceName)

        expect(pieces1).toContain('@acme/piece-internal-ctx1')
        expect(pieces1).not.toContain('@globex/piece-secret-ctx2')

        expect(pieces2).toContain('@globex/piece-secret-ctx2')
        expect(pieces2).not.toContain('@acme/piece-internal-ctx1')
    })
})
