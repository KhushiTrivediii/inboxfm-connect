import { apId } from '@inboxfm-connect/core-utils'
import { PropertyType } from '@inboxfm-connect/pieces-framework'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { AppConnectionType, PackageType, PieceType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { db } from '../../../helpers/db'
import {
    createMockConnectApiKey,
    createMockConnection,
    createMockOAuthApp,
    createMockPieceMetadata,
} from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let mockLog: FastifyBaseLogger

beforeAll(async () => {
    app = await setupTestEnvironment()
    mockLog = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// The consumer backend is the only holder of the Connect API key, so the suite
// talks to the session API exactly the way an embedded third-party app would:
// a bare bearer token, never a platform user session.
async function createConsumer(ctx: TestContext): Promise<string> {
    const connectApiKey = createMockConnectApiKey({
        platformId: ctx.platform.id,
        projectId: ctx.project.id,
    })
    await db.save('connect_api_key', connectApiKey)
    return connectApiKey.value
}

async function seedPiece({ platformId, oauth }: { platformId: string, oauth?: boolean }) {
    const piece = createMockPieceMetadata({
        platformId,
        packageType: PackageType.REGISTRY,
        // The registry only serves OFFICIAL pieces with no platform, or CUSTOM
        // pieces bound to this platform — an OFFICIAL piece carrying a platformId
        // is filtered out and never resolves.
        pieceType: PieceType.CUSTOM,
        auth: oauth ? providerOAuth2Auth() : undefined,
    })
    await db.save('integration_metadata', piece)
    return piece
}

function providerOAuth2Auth() {
    return {
        type: PropertyType.OAUTH2,
        required: true,
        authUrl: 'https://provider.example/oauth/authorize',
        tokenUrl: 'https://provider.example/oauth/token',
        scope: ['openid', 'email'],
    }
}

function mintSession({ apiKey, body }: { apiKey: string, body: Record<string, unknown> }) {
    return app!.inject({
        method: 'POST',
        url: '/api/v1/connect-sessions',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: body,
    })
}

function redeem({ token, body }: { token: string, body: Record<string, unknown> }) {
    return app!.inject({
        method: 'POST',
        url: `/api/v1/connect-sessions/${token}/connections`,
        payload: body,
    })
}

function redemptionBody({ piece, projectId, externalId }: { piece: { name: string, version: string }, projectId: string, externalId: string }): Record<string, unknown> {
    return {
        projectId,
        externalId,
        displayName: 'Customer connection',
        pieceName: piece.name,
        pieceVersion: piece.version,
        type: AppConnectionType.SECRET_TEXT,
        value: {
            type: AppConnectionType.SECRET_TEXT,
            secret_text: 'consumer-held-secret',
        },
    }
}

function execute(ctx: TestContext, body: Record<string, unknown>) {
    return ctx.post('/v1/execute', body)
}

describe('Connect acceptance journey (issue #212)', () => {
    describe('Consumer backend onboarding', () => {
        it('mints a connect session from a Connect API key held on the consumer backend', async () => {
            const ctx = await createTestContext(app!)
            const apiKey = await createConsumer(ctx)

            const response = await mintSession({
                apiKey,
                body: { projectId: ctx.project.id, externalUserId: 'customer-onboarded' },
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response!.json()
            expect(body.token).toMatch(/^cs-/)
            expect(body.connectUrl).toContain(body.token)
            expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
        })

        it('restricts the session to the integrations the consumer allowed', async () => {
            const ctx = await createTestContext(app!)
            const apiKey = await createConsumer(ctx)
            const allowedPiece = await seedPiece({ platformId: ctx.platform.id })
            const forbiddenPiece = await seedPiece({ platformId: ctx.platform.id })

            const session = await mintSession({
                apiKey,
                body: {
                    projectId: ctx.project.id,
                    externalUserId: 'customer-scoped',
                    allowedPieceNames: [allowedPiece.name],
                },
            })
            expect(session?.statusCode).toBe(StatusCodes.CREATED)
            const token = session!.json().token

            const denied = await redeem({
                token,
                body: redemptionBody({ piece: forbiddenPiece, projectId: ctx.project.id, externalId: 'customer-scoped' }),
            })
            expect(denied?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(denied!.json().code).toBe('AUTHORIZATION')

            const allowed = await redeem({
                token,
                body: redemptionBody({ piece: allowedPiece, projectId: ctx.project.id, externalId: 'customer-scoped' }),
            })
            expect(allowed?.statusCode).toBe(StatusCodes.CREATED)
            expect(allowed!.json().value).toBeUndefined()
        })
    })

    describe('Provider authorization (operator-owned OAuth app)', () => {
        it('builds the provider authorization URL from the operator-configured OAuth app', async () => {
            const ctx = await createTestContext(app!)
            const apiKey = await createConsumer(ctx)
            const piece = await seedPiece({ platformId: ctx.platform.id, oauth: true })
            const oauthApp = await createMockOAuthApp({ platformId: ctx.platform.id, pieceName: piece.name })
            await db.save('connect_oauth_app', oauthApp)

            const session = await mintSession({
                apiKey,
                body: { projectId: ctx.project.id, externalUserId: 'customer-oauth' },
            })
            const token = session!.json().token

            const response = await app!.inject({
                method: 'POST',
                url: `/api/v1/connect-sessions/${token}/oauth2/authorization-url`,
                payload: {
                    pieceName: piece.name,
                    pieceVersion: piece.version,
                    redirectUrl: 'https://consumer.example/callback',
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const authorizationUrl = response!.json().authorizationUrl
            expect(authorizationUrl).toContain(oauthApp.clientId)
            expect(authorizationUrl).toContain(encodeURIComponent('https://consumer.example/callback'))
        })

        it('refuses to authorize a piece the operator has not configured an OAuth app for', async () => {
            const ctx = await createTestContext(app!)
            const apiKey = await createConsumer(ctx)
            const piece = await seedPiece({ platformId: ctx.platform.id, oauth: true })

            const session = await mintSession({
                apiKey,
                body: { projectId: ctx.project.id, externalUserId: 'customer-no-oauth' },
            })
            const token = session!.json().token

            const response = await app!.inject({
                method: 'POST',
                url: `/api/v1/connect-sessions/${token}/oauth2/authorization-url`,
                payload: { pieceName: piece.name, redirectUrl: 'https://consumer.example/callback' },
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response!.json().code).toBe('INVALID_APP_CONNECTION')
        })
    })

    describe('Cross-customer and cross-project isolation', () => {
        it('refuses to execute against a connection owned by another project', async () => {
            const victim = await createTestContext(app!)
            const piece = await seedPiece({ platformId: victim.platform.id })
            const victimConnection = createMockConnection({
                platformId: victim.platform.id,
                projectIds: [victim.project.id],
                pieceName: piece.name,
                pieceVersion: piece.version,
                externalId: 'victim-customer',
            }, victim.user.id)
            await db.save('app_connection', victimConnection)

            const attacker = await createTestContext(app!)
            const response = await execute(attacker, {
                projectId: attacker.project.id,
                integration: piece.name,
                tool: 'noop',
                connectionId: victimConnection.id,
                input: {},
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
            expect(response!.json().code).toBe('ENTITY_NOT_FOUND')
        })

        it('refuses to resolve another customer connection through externalUserId', async () => {
            const ctx = await createTestContext(app!)
            const piece = await seedPiece({ platformId: ctx.platform.id })
            const connection = createMockConnection({
                platformId: ctx.platform.id,
                projectIds: [ctx.project.id],
                pieceName: piece.name,
                pieceVersion: piece.version,
                externalId: 'customer-one',
            }, ctx.user.id)
            await db.save('app_connection', connection)

            const response = await execute(ctx, {
                projectId: ctx.project.id,
                integration: piece.name,
                tool: 'noop',
                externalUserId: 'customer-two',
                input: {},
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('refuses an explicit connectionId paired with a different customer id', async () => {
            const ctx = await createTestContext(app!)
            const piece = await seedPiece({ platformId: ctx.platform.id })
            const connection = createMockConnection({
                platformId: ctx.platform.id,
                projectIds: [ctx.project.id],
                pieceName: piece.name,
                pieceVersion: piece.version,
                externalId: 'customer-one',
            }, ctx.user.id)
            await db.save('app_connection', connection)

            const response = await execute(ctx, {
                projectId: ctx.project.id,
                integration: piece.name,
                tool: 'noop',
                connectionId: connection.id,
                externalUserId: 'customer-two',
                input: {},
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('refuses an explicit connectionId minted for a different piece', async () => {
            const ctx = await createTestContext(app!)
            const pieceA = await seedPiece({ platformId: ctx.platform.id })
            const pieceB = await seedPiece({ platformId: ctx.platform.id })
            const connection = createMockConnection({
                platformId: ctx.platform.id,
                projectIds: [ctx.project.id],
                pieceName: pieceA.name,
                pieceVersion: pieceA.version,
                externalId: 'customer-one',
            }, ctx.user.id)
            await db.save('app_connection', connection)

            const response = await execute(ctx, {
                projectId: ctx.project.id,
                integration: pieceB.name,
                tool: 'noop',
                connectionId: connection.id,
                input: {},
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
            expect(response!.json().code).toBe('ENTITY_NOT_FOUND')
        })

        it('ignores projectId and externalUserId supplied in the redemption body — the session wins', async () => {
            const ctx = await createTestContext(app!)
            const apiKey = await createConsumer(ctx)
            const piece = await seedPiece({ platformId: ctx.platform.id })
            const otherProject = (await createTestContext(app!)).project

            const session = await mintSession({
                apiKey,
                body: { projectId: ctx.project.id, externalUserId: 'session-customer' },
            })
            const token = session!.json().token

            const response = await redeem({
                token,
                body: redemptionBody({ piece, projectId: otherProject.id, externalId: 'spoofed-customer' }),
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const connection = response!.json()
            expect(connection.projectId ?? connection.projectIds).toEqual([ctx.project.id])
            const stored = await db.findOneByOrFail<{ externalId: string, projectIds: string[] }>(
                'app_connection',
                { id: connection.id },
            )
            expect(stored.externalId).toBe('session-customer')
            expect(stored.projectIds).toEqual([ctx.project.id])
        })
    })

    describe('Session lifecycle', () => {
        it('expires a session once its TTL has passed', async () => {
            const ctx = await createTestContext(app!)
            const apiKey = await createConsumer(ctx)
            const piece = await seedPiece({ platformId: ctx.platform.id })

            const session = await mintSession({
                apiKey,
                body: { projectId: ctx.project.id, externalUserId: 'customer-expired' },
            })
            const token = session!.json().token
            const row = await db.findOneByOrFail<{ id: string }>('connect_session', {
                hashedToken: cryptoUtils.hashSHA256(token),
            })
            await db.update('connect_session', row.id, {
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
            })

            const response = await redeem({
                token,
                body: redemptionBody({ piece, projectId: ctx.project.id, externalId: 'customer-expired' }),
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(response!.json().code).toBe('SESSION_EXPIRED')
        })

        it('refuses to redeem a session twice', async () => {
            const ctx = await createTestContext(app!)
            const apiKey = await createConsumer(ctx)
            const piece = await seedPiece({ platformId: ctx.platform.id })

            const session = await mintSession({
                apiKey,
                body: { projectId: ctx.project.id, externalUserId: 'customer-once' },
            })
            const token = session!.json().token
            const body = redemptionBody({ piece, projectId: ctx.project.id, externalId: 'customer-once' })

            const first = await redeem({ token, body })
            expect(first?.statusCode).toBe(StatusCodes.CREATED)

            const second = await redeem({ token, body })
            expect(second?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(second!.json().code).toBe('SESSION_EXPIRED')
        })

        it('ends the journey with the session consumed exactly once when two redemptions race', async () => {
            const ctx = await createTestContext(app!)
            const apiKey = await createConsumer(ctx)
            const piece = await seedPiece({ platformId: ctx.platform.id })

            const session = await mintSession({
                apiKey,
                body: { projectId: ctx.project.id, externalUserId: 'customer-race' },
            })
            const token = session!.json().token
            const body = redemptionBody({ piece, projectId: ctx.project.id, externalId: 'customer-race' })

            const [first, second] = await Promise.all([
                redeem({ token, body }),
                redeem({ token, body }),
            ])

            const statuses = [first!.statusCode, second!.statusCode].sort((a, b) => a - b)
            expect(statuses).toEqual([StatusCodes.CREATED, StatusCodes.FORBIDDEN])

            const connections = await db.findManyBy<{ id: string }>('app_connection', {
                externalId: 'customer-race',
            })
            expect(connections).toHaveLength(1)

            const late = await redeem({ token, body })
            expect(late?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(late!.json().code).toBe('SESSION_EXPIRED')

            const rows = await db.findManyBy<{ consumedAt: string | null }>('connect_session', {
                projectId: ctx.project.id,
            })
            expect(rows).toHaveLength(1)
            expect(rows[0].consumedAt).not.toBeNull()
        })
    })

    describe('Credential hygiene', () => {
        it('never returns the Connect API key hash, the session token hash, or the connection secret', async () => {
            const ctx = await createTestContext(app!)
            const apiKey = await createConsumer(ctx)
            const piece = await seedPiece({ platformId: ctx.platform.id })

            const session = await mintSession({
                apiKey,
                body: { projectId: ctx.project.id, externalUserId: 'customer-hygiene' },
            })
            const token = session!.json().token
            expect(session!.json().hashedToken).toBeUndefined()

            const info = await app!.inject({ method: 'GET', url: `/api/v1/connect-sessions/${token}` })
            expect(info?.statusCode).toBe(StatusCodes.OK)
            expect(info!.json().hashedToken).toBeUndefined()

            const connection = await redeem({
                token,
                body: redemptionBody({ piece, projectId: ctx.project.id, externalId: 'customer-hygiene' }),
            })
            expect(connection?.statusCode).toBe(StatusCodes.CREATED)
            expect(connection!.json().value).toBeUndefined()

            const stored = await db.findOneByOrFail<{ id: string }>('connect_session', {
                hashedToken: cryptoUtils.hashSHA256(token),
            })
            expect(stored).toBeDefined()
            expect(apId()).not.toBe(stored.id)
        })
    })
})
