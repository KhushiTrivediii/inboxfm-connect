import { connectOAuthAppService } from '../../../../src/app/connect-oauth-apps/connect-oauth-app.service'
import { db } from '../../../helpers/db'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

beforeAll(async () => {
    await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('connectOAuthAppService.upsert primary-key stability', () => {
    it('keeps the row id stable across re-upserts so the first id stays addressable', async () => {
        // arrange
        const { mockPlatform } = await mockAndSaveBasicSetup()

        // act - first upsert creates the row
        const first = await connectOAuthAppService.upsert({
            platformId: mockPlatform.id,
            request: {
                pieceName: 'gmail',
                clientId: 'client-a',
                clientSecret: 'secret-a',
            },
        })

        // re-upsert with rotated credentials must update the SAME row
        const second = await connectOAuthAppService.upsert({
            platformId: mockPlatform.id,
            request: {
                pieceName: 'gmail',
                clientId: 'client-b',
                clientSecret: 'secret-b',
            },
        })

        // assert - the id handed back by the first upsert is the one still stored,
        // so a caller that persisted it can keep addressing the row
        expect(second.id).toBe(first.id)
        expect(second.clientId).toBe('client-b')

        // exactly one row survives for the natural key
        const rows = await db.findManyBy('connect_oauth_app', {
            platformId: mockPlatform.id,
            pieceName: 'gmail',
        })
        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe(first.id)

        // the original id still resolves, and the read-back carries the rotated
        // credentials rather than the ones the first upsert stored
        const stored = await db.findOneByOrFail<{ id: string, clientId: string }>('connect_oauth_app', { id: first.id })
        expect(stored.clientId).toBe('client-b')

        const withSecret = await connectOAuthAppService.getWithSecretOrThrow({
            platformId: mockPlatform.id,
            pieceName: 'gmail',
        })
        expect(withSecret.clientSecret).toBe('secret-b')
    })

    it('scopes rows per platform so the same piece on two platforms stays independent', async () => {
        // arrange
        const { mockPlatform: platformA } = await mockAndSaveBasicSetup()
        const { mockPlatform: platformB } = await mockAndSaveBasicSetup()

        // act - same piece name, two platforms
        const a = await connectOAuthAppService.upsert({
            platformId: platformA.id,
            request: { pieceName: 'slack', clientId: 'client-a', clientSecret: 'secret-a' },
        })
        const b = await connectOAuthAppService.upsert({
            platformId: platformB.id,
            request: { pieceName: 'slack', clientId: 'client-b', clientSecret: 'secret-b' },
        })

        // assert - the conflict target includes platformId, so these never collide
        expect(a.id).not.toBe(b.id)

        const aSecret = await connectOAuthAppService.getWithSecretOrThrow({
            platformId: platformA.id,
            pieceName: 'slack',
        })
        expect(aSecret.clientSecret).toBe('secret-a')
    })
})
