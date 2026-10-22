import { faker } from '@faker-js/faker'
import { ActivepiecesError, apId, secureApId } from '@inboxfm-connect/core-utils'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { FastifyInstance } from 'fastify'
import { connectSessionService } from '../../../../src/app/connect-sessions/connect-session.service'
import { db } from '../../../helpers/db'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

function mockConnectSession(projectId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const raw = `cs-${secureApId(61)}`
    return {
        id: apId(),
        created: faker.date.recent().toISOString(),
        updated: faker.date.recent().toISOString(),
        projectId,
        externalUserId: faker.string.alphanumeric(10),
        allowedPieceNames: null,
        hashedToken: cryptoUtils.hashSHA256(raw),
        truncatedToken: raw.slice(-4),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        consumedAt: null,
        ...overrides,
    }
}

describe('Connect session single-use guarantee (consumeOrThrow)', () => {
    it('rejects a second redemption of the same session id', async () => {
        const { mockProject } = await mockAndSaveBasicSetup()
        const session = mockConnectSession(mockProject.id)
        await db.save('connect_session', session)

        await expect(connectSessionService.consumeOrThrow(session.id as string)).resolves.toBeUndefined()
        await expect(connectSessionService.consumeOrThrow(session.id as string)).rejects.toThrow(ActivepiecesError)
    })

    it('rejects consumption of an expired session even when consumedAt is null', async () => {
        const { mockProject } = await mockAndSaveBasicSetup()
        const session = mockConnectSession(mockProject.id, {
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })
        await db.save('connect_session', session)

        await expect(connectSessionService.consumeOrThrow(session.id as string)).rejects.toThrow(ActivepiecesError)
    })

    it('does not overwrite an existing consumedAt timestamp', async () => {
        const { mockProject } = await mockAndSaveBasicSetup()
        const originalConsumedAt = new Date(Date.now() - 30_000).toISOString()
        const session = mockConnectSession(mockProject.id, { consumedAt: originalConsumedAt })
        await db.save('connect_session', session)

        await expect(connectSessionService.consumeOrThrow(session.id as string)).rejects.toThrow(ActivepiecesError)
        const stored = await db.findOneByOrFail<{ consumedAt: string | null }>('connect_session', { id: session.id })
        expect(stored.consumedAt).toBe(originalConsumedAt)
    })
})

describe('Connect session cleanup (deleteExpiredBefore)', () => {
    it('removes sessions expired before the boundary and keeps live ones', async () => {
        const { mockProject } = await mockAndSaveBasicSetup()
        const expiredConsumed = mockConnectSession(mockProject.id, {
            expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            consumedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        })
        const expiredUnconsumed = mockConnectSession(mockProject.id, {
            expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        })
        const liveSession = mockConnectSession(mockProject.id)
        await db.save('connect_session', [expiredConsumed, expiredUnconsumed, liveSession])

        const boundary = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const deleted = await connectSessionService.deleteExpiredBefore({ boundaryIso: boundary })

        expect(deleted).toBe(2)
        await expect(db.findOneBy('connect_session', { id: expiredConsumed.id })).resolves.toBeNull()
        await expect(db.findOneBy('connect_session', { id: expiredUnconsumed.id })).resolves.toBeNull()
        await expect(db.findOneBy('connect_session', { id: liveSession.id })).resolves.not.toBeNull()
    })

    it('is a no-op when nothing is eligible', async () => {
        const deleted = await connectSessionService.deleteExpiredBefore({
            boundaryIso: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        })
        expect(deleted).toBe(0)
    })
})

describe('Connect session endpoint redemption (POST /:token/connections)', () => {
    const SECRET_TEXT_BODY = (projectId: string) => ({
        type: 'SECRET_TEXT',
        externalId: 'test-external-id',
        displayName: 'Test Connection',
        pieceName: 'pieces/filter',
        pieceVersion: '1.0.0',
        projectId,
        value: { type: 'SECRET_TEXT', secret_text: 'super-secret' },
    })

    it('rejects a redemption of an already-consumed session and persists no connection', async () => {
        const { mockProject } = await mockAndSaveBasicSetup()
        const raw = `cs-${'x'.repeat(61)}`
        const session = mockConnectSession(mockProject.id, {
            hashedToken: cryptoUtils.hashSHA256(raw),
            truncatedToken: raw.slice(-4),
            consumedAt: new Date().toISOString(),
        })
        await db.save('connect_session', session)

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/connect-sessions/${raw}/connections`,
            payload: SECRET_TEXT_BODY(mockProject.id),
        })

        expect(response.statusCode).toBe(403)
        // no connection row may be created when the claim fails
        const connections = await db.findManyBy('app_connection', {
            externalId: session.externalUserId,
        })
        expect(connections).toHaveLength(0)
    })

    it('rejects a redemption of an expired-but-unconsumed session and persists no connection', async () => {
        const { mockProject } = await mockAndSaveBasicSetup()
        const raw = `cs-${'y'.repeat(61)}`
        const session = mockConnectSession(mockProject.id, {
            hashedToken: cryptoUtils.hashSHA256(raw),
            truncatedToken: raw.slice(-4),
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            consumedAt: null,
        })
        await db.save('connect_session', session)

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/connect-sessions/${raw}/connections`,
            payload: SECRET_TEXT_BODY(mockProject.id),
        })

        expect(response.statusCode).toBe(403)
        const connections = await db.findManyBy('app_connection', { externalId: session.externalUserId })
        expect(connections).toHaveLength(0)
    })

    it('lets exactly one of two concurrent redemptions win and the loser persists nothing', async () => {
        const { mockProject } = await mockAndSaveBasicSetup()
        const raw = `cs-${'z'.repeat(61)}`
        const session = mockConnectSession(mockProject.id, {
            hashedToken: cryptoUtils.hashSHA256(raw),
            truncatedToken: raw.slice(-4),
        })
        await db.save('connect_session', session)

        const [winner, loser] = await Promise.all([
            app.inject({ method: 'POST', url: `/api/v1/connect-sessions/${raw}/connections`, payload: SECRET_TEXT_BODY(mockProject.id) }),
            app.inject({ method: 'POST', url: `/api/v1/connect-sessions/${raw}/connections`, payload: SECRET_TEXT_BODY(mockProject.id) }),
        ])

        const statuses = [winner.statusCode, loser.statusCode].sort()
        expect(statuses).toEqual([201, 403])
        // The connection's externalId is derived from the session, not the request body
        const successes = (await db.findManyBy('app_connection', { externalId: session.externalUserId })).length
        expect(successes).toBe(1)
    })

    it('keeps project A cleanup from touching project B sessions (cross-project isolation)', async () => {
        const setupA = await mockAndSaveBasicSetup()
        const setupB = await mockAndSaveBasicSetup()
        const expiredInA = mockConnectSession(setupA.mockProject.id, {
            expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        })
        const liveInB = mockConnectSession(setupB.mockProject.id)
        await db.save('connect_session', [expiredInA, liveInB])

        const deleted = await connectSessionService.deleteExpiredBefore({
            boundaryIso: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        })

        expect(deleted).toBe(1)
        await expect(db.findOneBy('connect_session', { id: expiredInA.id })).resolves.toBeNull()
        await expect(db.findOneBy('connect_session', { id: liveInB.id })).resolves.not.toBeNull()
    })
})