import { DefaultProjectRole } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectSessionService } from '../../../../src/app/connect-sessions/connect-session.service'
import { db } from '../../../helpers/db'
import { createMemberContext, createServiceContext, createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

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

describe('Connect public API surface (Issue #135)', () => {
    let ctx: TestContext

    beforeEach(async () => {
        ctx = await createTestContext(app!)
    })

    describe('Connect OAuth apps (platform-admin upsert)', () => {
        it('upserts an OAuth app without leaking the client secret', async () => {
            const response = await ctx.post('/v1/connect-oauth-apps', {
                pieceName: '@inboxfm-connect/piece-slack',
                clientId: 'operator-client-id',
                clientSecret: 'operator-client-secret',
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.clientId).toBe('operator-client-id')
            expect(body.platformId).toBe(ctx.platform.id)
            expect(body.clientSecret).toBeUndefined()
            expect(JSON.stringify(body)).not.toContain('operator-client-secret')
        })

        it('rejects upsert for a non-admin platform member with 403', async () => {
            const memberCtx = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.VIEWER })

            const response = await memberCtx.post('/v1/connect-oauth-apps', {
                pieceName: '@inboxfm-connect/piece-slack',
                clientId: 'operator-client-id',
                clientSecret: 'operator-client-secret',
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })

    describe('Connect sessions (token-gated lifecycle)', () => {
        it('creates a session for a SERVICE principal and stores only the hash', async () => {
            const serviceCtx = await createServiceContext(app!, ctx)
            const response = await serviceCtx.post('/v1/connect-sessions', {
                projectId: ctx.project.id,
                externalUserId: 'customer_42',
                allowedPieceNames: ['@inboxfm-connect/piece-slack'],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body.token).toMatch(/^cs-/)
            expect(body.connectUrl).toContain(body.token)
            expect(body.expiresAt).toBeDefined()

            const rows = await db.findManyBy<{ hashedToken: string }>('connect_session', { projectId: ctx.project.id })
            expect(rows).toHaveLength(1)
            expect(rows[0].hashedToken).toBeDefined()
            expect(rows[0].hashedToken).not.toContain(body.token)
        })

        it('rejects session creation for a USER principal with 403', async () => {
            const response = await ctx.post('/v1/connect-sessions', {
                projectId: ctx.project.id,
                externalUserId: 'customer_42',
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('redeems a session idempotently before use', async () => {
            const serviceCtx = await createServiceContext(app!, ctx)
            const created = await serviceCtx.post('/v1/connect-sessions', {
                projectId: ctx.project.id,
                externalUserId: 'customer_42',
            })
            const token = created?.json().token as string

            for (let attempt = 0; attempt < 2; attempt++) {
                const redeemed = await app!.inject({
                    method: 'GET',
                    url: `/api/v1/connect-sessions/${token}`,
                })
                expect(redeemed.statusCode).toBe(StatusCodes.OK)
                expect(redeemed.json().externalUserId).toBe('customer_42')
                expect(redeemed.json().projectId).toBe(ctx.project.id)
            }
        })

        it('rejects an unknown token with 404', async () => {
            const response = await app!.inject({
                method: 'GET',
                url: '/api/v1/connect-sessions/cs-unknowntoken0000000000000000000000000000000000000000000001',
            })

            expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('rejects an expired session', async () => {
            const serviceCtx = await createServiceContext(app!, ctx)
            const created = await serviceCtx.post('/v1/connect-sessions', {
                projectId: ctx.project.id,
                externalUserId: 'customer_42',
                expiresInSeconds: 3600,
            })
            const token = created?.json().token as string
            const [row] = await db.findManyBy<{ id: string }>('connect_session', { projectId: ctx.project.id })
            await db.update('connect_session', row.id, { expiresAt: new Date(Date.now() - 60_000).toISOString() })

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/connect-sessions/${token}`,
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('rejects a consumed session', async () => {
            const serviceCtx = await createServiceContext(app!, ctx)
            const created = await serviceCtx.post('/v1/connect-sessions', {
                projectId: ctx.project.id,
                externalUserId: 'customer_42',
            })
            const token = created?.json().token as string
            const [row] = await db.findManyBy<{ id: string }>('connect_session', { projectId: ctx.project.id })
            await connectSessionService.consumeOrThrow(row.id)

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/connect-sessions/${token}`,
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('rejects a disallowed piece on the authorization-url step', async () => {
            const serviceCtx = await createServiceContext(app!, ctx)
            const created = await serviceCtx.post('/v1/connect-sessions', {
                projectId: ctx.project.id,
                externalUserId: 'customer_42',
                allowedPieceNames: ['@inboxfm-connect/piece-slack'],
            })
            const token = created?.json().token as string

            const response = await app!.inject({
                method: 'POST',
                url: `/api/v1/connect-sessions/${token}/oauth2/authorization-url`,
                payload: {
                    pieceName: '@inboxfm-connect/piece-github',
                    redirectUrl: 'https://app.example/callback',
                },
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })
})
