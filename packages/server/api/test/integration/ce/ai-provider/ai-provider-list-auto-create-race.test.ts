import { AIProviderName } from '@inboxfm-connect/core-utils'
import { PrincipalType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderSchema } from '../../../../src/app/ai/ai-provider-entity'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { generateMockToken } from '../../../helpers/auth'
import { mockAndSaveAIProvider, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

async function deleteKeysByPattern(redis: Redis, pattern: string): Promise<void> {
    const stream = redis.scanStream({ match: pattern, count: 100 })
    for await (const keys of stream) {
        if (keys.length > 0) {
            await redis.del(...keys)
        }
    }
}

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
    // The auto-create branch is gated on the managed-AI flag; point the gate
    // at a configured key for the whole suite so every list call exercises
    // the branch (the gate is read per-request, not memoized).
    const originalGet = system.get.bind(system)
    vi.spyOn(system, 'get').mockImplementation((prop: AppSystemProp) => {
        if (prop === AppSystemProp.OPENROUTER_PROVISION_KEY) {
            return 'test-provision-key'
        }
        return originalGet(prop)
    })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    const redis = await redisConnections.useExisting()
    // redlock:* covers every live lock key (redlock prefixes resources)
    await deleteKeysByPattern(redis, 'redlock:*')
})

async function testSetupWithToken(): Promise<{ mockPlatform: { id: string }, mockUserToken: string }> {
    const { mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
    const mockUserToken = await generateMockToken({
        id: mockOwner.id,
        type: PrincipalType.USER,
        platform: { id: mockPlatform.id },
    })
    return { mockPlatform, mockUserToken }
}

describe('AI Providers API - concurrent list auto-create race', () => {
    it('concurrent first GET /v1/ai-providers calls all succeed and create exactly one ACTIVEPIECES row', async () => {
        // arrange
        const { mockPlatform, mockUserToken } = await testSetupWithToken()

        const makeRequest = () => app!.inject({
            method: 'GET',
            url: '/api/v1/ai-providers',
            headers: {
                authorization: 'Bearer ' + mockUserToken,
            },
        })

        // act - five simultaneous first-ever list calls on a platform that
        // has no providers yet. Pre-fix, every call passes the existsBy
        // check before any insert lands, so four of the five save() calls
        // hit the unique index (platformId, provider) and the losers
        // surface raw driver errors (500 / 409) on a plain GET route.
        const responses = await Promise.all([
            makeRequest(),
            makeRequest(),
            makeRequest(),
            makeRequest(),
            makeRequest(),
        ])

        // assert
        const codes = responses.map((r) => r.statusCode)
        expect(codes.filter((code) => code === StatusCodes.OK)).toHaveLength(5)

        const rows = await databaseConnection().getRepository('ai_provider').find({
            where: { platformId: mockPlatform.id, provider: AIProviderName.ACTIVEPIECES },
        })
        expect(rows).toHaveLength(1)
        expect(rows[0].enabledForChat).toBe(true)
    })

    it('auto-create racing an admin chat-assignment update leaves exactly one provider enabled for chat', async () => {
        // arrange - the codeant Major on #472: the auto-create reads
        // hasChatProvider and then inserts enabledForChat when no chat
        // provider exists, while update() flips all providers off and its
        // chosen one on inside a transaction. Without a shared lock the two
        // interleave: auto-create reads "no chat provider" while the admin
        // transaction is mid-flight, then both land enabledForChat=true.
        const { mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockUserToken = await generateMockToken({
            id: mockOwner.id,
            type: PrincipalType.USER,
            platform: { id: mockPlatform.id },
        })
        const headers = { authorization: 'Bearer ' + mockUserToken }

        // a BYO provider that an admin will assign chat to concurrently
        const byoProvider = await mockAndSaveAIProvider({
            platformId: mockPlatform.id,
            provider: AIProviderName.CUSTOM,
            displayName: 'BYO Custom',
            config: {
                baseUrl: 'https://api.example.com/v1',
                apiKeyHeader: 'Authorization',
                models: [],
            },
        })

        // park the auto-create's INSERT until the admin update has committed:
        // deterministic interleave via the shared repository save hook
        const repo = databaseConnection().getRepository<AIProviderSchema>('ai_provider')
        const repoSave = repo.save.bind(repo)
        const savedRows: unknown[] = []
        const parkedSave = async (row: Parameters<typeof repoSave>[0]): Promise<ReturnType<typeof repoSave>> => {
            const provider = Array.isArray(row) ? row[0]?.provider : row?.provider
            if (provider === AIProviderName.ACTIVEPIECES && savedRows.length === 0) {
                savedRows.push(row)
                // park briefly (well below the 60s lock lease): the admin
                // chat-assignment update must queue on the same lock instead
                // of interleaving between hasChatProvider read and insert
                await new Promise((resolve) => setTimeout(resolve, 400))
            }
            return repoSave(row)
        }
        repo.save = parkedSave

        const listCall = app!.inject({ method: 'GET', url: '/api/v1/ai-providers', headers })
        // wait until the auto-create has read hasChatProvider and is parked
        // inside its insert, then run the admin chat assignment to completion
        const deadline = Date.now() + 5000
        while (savedRows.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(savedRows.length).toBe(1)
        const adminUpdate = await app!.inject({
            method: 'POST',
            url: '/api/v1/ai-providers/' + byoProvider.id,
            headers,
            body: { displayName: 'BYO Custom', enabledForChat: true },
        })
        expect(adminUpdate.statusCode).toBe(StatusCodes.OK)
        const listResponse = await listCall
        expect(listResponse.statusCode).toBe(StatusCodes.OK)

        repo.save = repoSave

        // assert - exactly one provider is enabled for chat no matter how the
        // interleave resolved: the admin's explicit choice wins, or (if the
        // auto-create's enabledForChat decision landed first inside the lock)
        // the admin update ran after and still ended with exactly one
        const rows = await databaseConnection().getRepository('ai_provider').find({
            where: { platformId: mockPlatform.id },
        })
        const chatEnabled = rows.filter((r) => r.enabledForChat === true)
        expect(chatEnabled).toHaveLength(1)
    })

    it('sequential first GET calls do not create a second ACTIVEPIECES row', async () => {
        // arrange
        const { mockPlatform, mockUserToken } = await testSetupWithToken()

        const makeRequest = () => app!.inject({
            method: 'GET',
            url: '/api/v1/ai-providers',
            headers: {
                authorization: 'Bearer ' + mockUserToken,
            },
        })

        // act
        const first = await makeRequest()
        const second = await makeRequest()

        // assert
        expect(first.statusCode).toBe(StatusCodes.OK)
        expect(second.statusCode).toBe(StatusCodes.OK)

        const rows = await databaseConnection().getRepository('ai_provider').find({
            where: { platformId: mockPlatform.id, provider: AIProviderName.ACTIVEPIECES },
        })
        expect(rows).toHaveLength(1)
    })
})
