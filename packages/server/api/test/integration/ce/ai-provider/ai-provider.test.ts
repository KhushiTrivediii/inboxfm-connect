import { AIProviderName, apId, ErrorCode } from '@inboxfm-connect/core-utils'
import { DefaultProjectRole, PrincipalType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiProviders } from '../../../../src/app/ai/providers'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { mockAndSaveAIProvider } from '../../../helpers/mocks'
import { createMemberContext, createTestContext, TestContext } from '../../../helpers/test-context'
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
    ctx = await createTestContext(app!)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('AI Providers API', () => {
    describe('POST /v1/ai-providers/test (test connection)', () => {
        it('validates provider credentials statelessly and returns { valid: true }', async () => {
            const validateSpy = vi.spyOn(aiProviders[AIProviderName.OPENAI], 'validateConnection').mockResolvedValueOnce()

            const response = await ctx.post('/v1/ai-providers/test', {
                provider: AIProviderName.OPENAI,
                auth: { apiKey: 'sk-test-valid-key-123' },
                config: {},
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json()).toEqual({ valid: true })
            expect(validateSpy).toHaveBeenCalledTimes(1)
            expect(validateSpy).toHaveBeenCalledWith(
                { apiKey: 'sk-test-valid-key-123' },
                {},
                expect.anything(),
            )

            // Strict statelessness: no database row created
            const saved = await db.findOneBy('ai_provider', {
                platformId: ctx.platform.id,
                provider: AIProviderName.OPENAI,
            })
            expect(saved).toBeNull()
        })

        it('rejects invalid credentials with 400 and masked error payload', async () => {
            const sensitiveError = new Error('Upstream 401 with secret sk-leak-9988 at http://169.254.169.254/meta')
            const validateSpy = vi.spyOn(aiProviders[AIProviderName.OPENAI], 'validateConnection').mockRejectedValueOnce(sensitiveError)

            const response = await ctx.post('/v1/ai-providers/test', {
                provider: AIProviderName.OPENAI,
                auth: { apiKey: 'sk-invalid-key' },
                config: {},
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const body = response?.json()
            expect(body.code).toBe(ErrorCode.INVALID_AI_PROVIDER_CREDENTIALS)
            expect(body.params?.provider).toBe(AIProviderName.OPENAI)
            expect(body.params?.message).toBe('Failed to validate credentials for OpenAI')

            // Ensure no sensitive upstream tokens or IPs leaked to client
            const serialized = JSON.stringify(body)
            expect(serialized).not.toContain('sk-leak-9988')
            expect(serialized).not.toContain('169.254.169.254')
        })

        it('preserves strict statelessness and creates no entity in database', async () => {
            const response = await ctx.post('/v1/ai-providers/test', {
                provider: AIProviderName.CUSTOM,
                config: {
                    baseUrl: 'https://api.together.xyz/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
                auth: { apiKey: 'custom-key' },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json()).toEqual({ valid: true })

            const saved = await db.findOneBy('ai_provider', {
                platformId: ctx.platform.id,
            })
            expect(saved).toBeNull()
        })

        it('rejects test connection request from non-admin platform members with 403 Forbidden', async () => {
            const memberCtx = await createMemberContext(app!, ctx, {
                projectRole: DefaultProjectRole.ADMIN,
            })

            const response = await memberCtx.post('/v1/ai-providers/test', {
                provider: AIProviderName.OPENAI,
                auth: { apiKey: 'test-key' },
                config: {},
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('rejects test connection with invalid provider configuration (malformed Azure resourceName)', async () => {
            const response = await ctx.post('/v1/ai-providers/test', {
                provider: AIProviderName.AZURE,
                config: {
                    resourceName: 'evil.com#',
                },
                auth: { apiKey: 'test-key' },
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })

    describe('POST /v1/ai-providers (create)', () => {
        it('should create a custom provider with defaultHeaders', async () => {
            const response = await ctx.post('/v1/ai-providers', {
                provider: AIProviderName.CUSTOM,
                displayName: 'My Custom Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                    defaultHeaders: {
                        'X-Organization-Id': 'org-123',
                        'X-Tenant': 'tenant-abc',
                    },
                },
                auth: { apiKey: 'test-key' },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const saved = await db.findOneBy('ai_provider', {
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
            })
            expect((saved as any).config.defaultHeaders).toEqual({
                'X-Organization-Id': 'org-123',
                'X-Tenant': 'tenant-abc',
            })
        })

        it('rejects provider creation from non-admin platform members with 403 Forbidden', async () => {
            const memberCtx = await createMemberContext(app!, ctx, {
                projectRole: DefaultProjectRole.ADMIN,
            })
            const response = await memberCtx.post('/v1/ai-providers', {
                provider: AIProviderName.CUSTOM,
                displayName: 'Member Custom Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
                auth: { apiKey: 'test-key' },
            })
            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('rejects Azure provider with host-manipulating resourceName', async () => {
            const response = await ctx.post('/v1/ai-providers', {
                provider: AIProviderName.AZURE,
                displayName: 'Malicious Azure',
                config: {
                    resourceName: 'evil.com#',
                },
                auth: { apiKey: 'test-key' },
            })
            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })

    describe('POST /v1/ai-providers/:id (update)', () => {
        it('should update defaultHeaders on an existing provider', async () => {
            const provider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Existing Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            const response = await ctx.post(`/v1/ai-providers/${provider.id}`, {
                displayName: 'Existing Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                    defaultHeaders: { 'X-Custom': 'value-1' },
                },
                auth: { apiKey: 'test-key' },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const saved = await db.findOneBy('ai_provider', { id: provider.id })
            expect((saved as any).config.defaultHeaders).toEqual({ 'X-Custom': 'value-1' })
        })
    })

    describe('GET /v1/ai-providers/:provider/config', () => {
        it('should return config with defaultHeaders and platformId', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Config Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                    defaultHeaders: { 'X-Org': 'org-789' },
                },
            })

            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: ctx.project.id,
                platform: { id: ctx.platform.id },
            })

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/ai-providers/${AIProviderName.CUSTOM}/config`,
                headers: { authorization: `Bearer ${engineToken}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
           
            expect(body.provider).toBe(AIProviderName.CUSTOM)
            expect(body.platformId).toBe(ctx.platform.id)
            expect(body.config.defaultHeaders).toEqual({ 'X-Org': 'org-789' })
        })

        it('should return platformId even without custom headers config', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Minimal Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: ctx.project.id,
                platform: { id: ctx.platform.id },
            })

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/ai-providers/${AIProviderName.CUSTOM}/config`,
                headers: { authorization: `Bearer ${engineToken}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            expect(body.platformId).toBe(ctx.platform.id)
            expect(body.config.defaultHeaders).toBeUndefined()
        })
    })

    describe('GET /v1/ai-providers (list)', () => {
        it('should include config with defaultHeaders when listing providers', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Listed Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                    defaultHeaders: { 'X-Test': 'test' },
                },
            })

            const response = await ctx.get('/v1/ai-providers')

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            const customProvider = body.find(
                (p: any) => p.provider === AIProviderName.CUSTOM,
            )
            expect(customProvider).toBeDefined()
            expect(customProvider.config.defaultHeaders).toEqual({ 'X-Test': 'test' })
        })
    })
})
