import { AppCredentialType } from '@inboxfm-connect/shared'
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

describe('App Credentials API', () => {
    describe('POST /v1/app-credentials (Create)', () => {
        it('should create an OAuth2 app credential', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/app-credentials', {
                appName: 'test-oauth-app',
                projectId: ctx.project.id,
                settings: {
                    type: AppCredentialType.OAUTH2,
                    authUrl: 'https://example.com/auth',
                    tokenUrl: 'https://example.com/token',
                    clientId: 'test-client-id',
                    clientSecret: 'test-client-secret',
                    scope: 'read write',
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.appName).toBe('test-oauth-app')
            expect(body.projectId).toBe(ctx.project.id)
            expect(body.settings.type).toBe(AppCredentialType.OAUTH2)
            expect(body.id).toBeDefined()
        })

        it('should create an API_KEY app credential', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/app-credentials', {
                appName: 'test-api-key-app',
                projectId: ctx.project.id,
                settings: {
                    type: AppCredentialType.API_KEY,
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.appName).toBe('test-api-key-app')
            expect(body.settings.type).toBe(AppCredentialType.API_KEY)
        })
    })

    describe('GET /v1/app-credentials (List)', () => {
        it('should list app credentials', async () => {
            const ctx = await createTestContext(app!)

            await ctx.post('/v1/app-credentials', {
                appName: 'list-test-app',
                projectId: ctx.project.id,
                settings: {
                    type: AppCredentialType.API_KEY,
                },
            })

            const response = await ctx.get('/v1/app-credentials', { projectId: ctx.project.id })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBeGreaterThanOrEqual(1)
        })

        it('should filter by appName', async () => {
            const ctx = await createTestContext(app!)

            await ctx.post('/v1/app-credentials', {
                appName: 'filter-app-a',
                projectId: ctx.project.id,
                settings: { type: AppCredentialType.API_KEY },
            })

            await ctx.post('/v1/app-credentials', {
                appName: 'filter-app-b',
                projectId: ctx.project.id,
                settings: { type: AppCredentialType.API_KEY },
            })

            const response = await ctx.get('/v1/app-credentials', { projectId: ctx.project.id, appName: 'filter-app-a' })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBeGreaterThanOrEqual(1)
            for (const cred of body.data) {
                expect(cred.appName).toBe('filter-app-a')
            }
        })

        it('should censor client secrets in OAuth2 credentials', async () => {
            const ctx = await createTestContext(app!)

            await ctx.post('/v1/app-credentials', {
                appName: 'censor-test-app',
                projectId: ctx.project.id,
                settings: {
                    type: AppCredentialType.OAUTH2,
                    authUrl: 'https://example.com/auth',
                    tokenUrl: 'https://example.com/token',
                    clientId: 'test-client-id',
                    clientSecret: 'should-be-censored',
                    scope: 'read',
                },
            })

            const response = await ctx.get('/v1/app-credentials', { projectId: ctx.project.id, appName: 'censor-test-app' })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            const cred = body.data.find((c: Record<string, string>) => c.appName === 'censor-test-app')
            if (cred && cred.settings.type === AppCredentialType.OAUTH2) {
                expect(cred.settings.clientSecret).toBeUndefined()
            }
        })
    })

    describe('DELETE /v1/app-credentials/:id', () => {
        it('should delete an app credential', async () => {
            const ctx = await createTestContext(app!)

            const createResponse = await ctx.post('/v1/app-credentials', {
                appName: 'delete-test-app',
                projectId: ctx.project.id,
                settings: { type: AppCredentialType.API_KEY },
            })
            const credId = createResponse?.json().id

            const response = await ctx.delete(`/v1/app-credentials/${credId}`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
        })
    })
    describe('GET /v1/app-credentials (Security gating, #358)', () => {
        it('should reject an unauthenticated list request', async () => {
            const ctx = await createTestContext(app!)

            const response = await app?.inject({
                method: 'GET',
                url: `/api/v1/app-credentials?projectId=${ctx.project.id}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('should reject a caller from another platform listing credentials they do not belong to', async () => {
            const ctx = await createTestContext(app!)
            const other = await createTestContext(app!)

            const response = await other.get('/v1/app-credentials', {
                projectId: ctx.project.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })

})
