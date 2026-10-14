import { apId } from '@inboxfm-connect/core-utils'
import { AppCredentialType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { db } from '../../../helpers/db'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'
import { appCredentialService } from '../../../../src/app/ee/app-credentials/app-credentials.service'

// Report w5 finding 3: app_credential.settings (jsonb) held OAuth2 client
// secrets in plaintext, unlike app-connection values (encryptObject) and
// connect-oauth-app client secrets (encryptString). Writes now always
// encrypt settings with encryptUtils.encryptObject; reads shape-discriminate
// ({iv, data} envelope => decrypt, else legacy plaintext row => pass
// through), so pre-encryption rows keep working without a data migration.

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

const oauth2Settings = (suffix: string): {
    type: AppCredentialType.OAUTH2
    authUrl: string
    tokenUrl: string
    clientId: string
    clientSecret: string
    scope: string
} => ({
    type: AppCredentialType.OAUTH2,
    authUrl: `https://example.com/auth-${suffix}`,
    tokenUrl: `https://example.com/token-${suffix}`,
    clientId: `client-id-${suffix}`,
    clientSecret: `client-secret-${suffix}`,
    scope: 'read write',
})

const saveLegacyPlaintextRow = async (projectId: string, appName: string, settings: Record<string, unknown>): Promise<string> => {
    const id = apId()
    const now = new Date().toISOString()
    await db.save('app_credential', {
        id,
        created: now,
        updated: now,
        appName,
        projectId,
        // simulate a row written before encryption shipped: raw plaintext
        settings,
    })
    return id
}

describe('app-credentials encryption at rest (w5 finding 3)', () => {
    describe('encrypt-on-write', () => {
        it('stores the settings jsonb as an encrypted envelope, not plaintext', async () => {
            const ctx = await createTestContext(app!)
            const settings = oauth2Settings('at-rest')

            const response = await ctx.post('/v1/app-credentials', {
                appName: 'encrypted-at-rest-app',
                projectId: ctx.project.id,
                settings,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const id: string = response?.json().id

            const rawRow = await db.findOneByOrFail<Record<string, unknown>>('app_credential', { id })
            const storedSettings = rawRow.settings as Record<string, unknown>

            // the stored jsonb is the {iv, data} ciphertext envelope
            expect(typeof storedSettings.iv).toBe('string')
            expect((storedSettings.iv as string).length).toBeGreaterThan(0)
            expect(typeof storedSettings.data).toBe('string')
            expect((storedSettings.data as string).length).toBeGreaterThan(0)
            expect(storedSettings.type).toBeUndefined()

            // and no sensitive value survives anywhere in the row
            const serialized = JSON.stringify(rawRow)
            expect(serialized).not.toContain(settings.clientSecret)
            expect(serialized).not.toContain(settings.clientId)
        })

        it('stores API_KEY settings encrypted too, and they decrypt on read', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/app-credentials', {
                appName: 'encrypted-api-key-app',
                projectId: ctx.project.id,
                settings: { type: AppCredentialType.API_KEY },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const id: string = response?.json().id

            const rawRow = await db.findOneByOrFail<Record<string, unknown>>('app_credential', { id })
            const storedSettings = rawRow.settings as Record<string, unknown>
            expect(typeof storedSettings.iv).toBe('string')
            expect(typeof storedSettings.data).toBe('string')

            const readBack = await appCredentialService.getOneOrThrow(id)
            expect(readBack.settings.type).toBe(AppCredentialType.API_KEY)
        })
    })

    describe('decrypt-on-read round-trip', () => {
        it('getOneOrThrow returns the exact settings that were upserted (the connection-key consumer path)', async () => {
            const ctx = await createTestContext(app!)
            const settings = oauth2Settings('round-trip')

            const upserted = await appCredentialService.upsert({
                projectId: ctx.project.id,
                request: {
                    appName: 'round-trip-app',
                    projectId: ctx.project.id,
                    settings,
                },
            })

            expect(upserted).not.toBeNull()
            expect(upserted!.settings.type).toBe(AppCredentialType.OAUTH2)

            const readBack = await appCredentialService.getOneOrThrow(upserted!.id)
            expect(readBack.settings).toEqual(settings)
        })

        it('list decrypts settings while the route still censors clientSecret', async () => {
            const ctx = await createTestContext(app!)
            const settings = oauth2Settings('list-censor')

            await appCredentialService.upsert({
                projectId: ctx.project.id,
                request: {
                    appName: 'list-censor-app',
                    projectId: ctx.project.id,
                    settings,
                },
            })

            const response = await ctx.get('/v1/app-credentials', {
                projectId: ctx.project.id,
                appName: 'list-censor-app',
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const rows: { appName: string, settings: Record<string, unknown> }[] = response?.json().data
            expect(rows).toHaveLength(1)
            // decrypted non-secret fields are visible...
            expect(rows[0].settings.clientId).toBe(settings.clientId)
            expect(rows[0].settings.type).toBe(AppCredentialType.OAUTH2)
            // ...and the censoring on the list route stays intact
            expect(rows[0].settings.clientSecret).toBeUndefined()
        })
    })

    describe('back-compat: rows written before encryption shipped', () => {
        it('getOneOrThrow still reads a plaintext OAUTH2 row', async () => {
            const ctx = await createTestContext(app!)
            const settings = oauth2Settings('legacy')
            const id = await saveLegacyPlaintextRow(ctx.project.id, 'legacy-plaintext-app', settings)

            const readBack = await appCredentialService.getOneOrThrow(id)

            expect(readBack.id).toBe(id)
            expect(readBack.settings).toEqual(settings)
        })

        it('getOneOrThrow still reads a plaintext API_KEY row', async () => {
            const ctx = await createTestContext(app!)
            const id = await saveLegacyPlaintextRow(ctx.project.id, 'legacy-api-key-app', {
                type: AppCredentialType.API_KEY,
            })

            const readBack = await appCredentialService.getOneOrThrow(id)

            expect(readBack.settings).toEqual({ type: AppCredentialType.API_KEY })
        })

        it('list still reads and censors a plaintext row', async () => {
            const ctx = await createTestContext(app!)
            const settings = oauth2Settings('legacy-list')
            await saveLegacyPlaintextRow(ctx.project.id, 'legacy-list-app', settings)

            const response = await ctx.get('/v1/app-credentials', {
                projectId: ctx.project.id,
                appName: 'legacy-list-app',
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const rows: { settings: Record<string, unknown> }[] = response?.json().data
            expect(rows).toHaveLength(1)
            expect(rows[0].settings.clientId).toBe(settings.clientId)
            expect(rows[0].settings.clientSecret).toBeUndefined()
        })

        it('re-upserting a legacy row replaces the plaintext with ciphertext', async () => {
            const ctx = await createTestContext(app!)
            const settings = oauth2Settings('legacy-reencrypt')
            const id = await saveLegacyPlaintextRow(ctx.project.id, 'legacy-reencrypt-app', settings)

            await appCredentialService.upsert({
                projectId: ctx.project.id,
                request: {
                    id,
                    appName: 'legacy-reencrypt-app',
                    projectId: ctx.project.id,
                    settings,
                },
            })

            const rawRow = await db.findOneByOrFail<Record<string, unknown>>('app_credential', { id })
            const storedSettings = rawRow.settings as Record<string, unknown>
            expect(typeof storedSettings.iv).toBe('string')
            expect(JSON.stringify(rawRow)).not.toContain(settings.clientSecret)

            const readBack = await appCredentialService.getOneOrThrow(id)
            expect(readBack.settings).toEqual(settings)
        })
    })
})
