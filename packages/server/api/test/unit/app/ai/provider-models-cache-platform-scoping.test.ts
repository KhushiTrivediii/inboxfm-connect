import { AIProviderName } from '@inboxfm-connect/core-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Review spot-check on #403 (platform scoping): two platforms alternating on
// the same provider used to run a supersession sweep that matched every
// entry with the provider prefix - each platform deleted the other's cached
// entry, so the cache never hit. The cache key now carries platformId and
// the sweep only matches this platform's entries.

const mockFindOneBy = vi.fn()
const mockListModels = vi.fn()

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        findOneBy: mockFindOneBy,
    }),
}))

vi.mock('../../../../src/app/helper/encryption', () => ({
    encryptUtils: {
        decryptObject: async <T>(v: T) => v,
    },
    EncryptedObject: {},
}))

vi.mock('../../../../src/app/ai/providers', () => ({
    aiProviders: {
        [AIProviderName.OPENAI]: {
            listModels: mockListModels,
        },
    },
}))

vi.mock('../../../../src/app/flags/flag.service', () => ({
    flagService: {},
}))

vi.mock('node-cron', () => ({
    default: {
        schedule: vi.fn(),
    },
}))

const log: never = {} as never

type AIProviderService = ReturnType<typeof import('../../../../src/app/ai/ai-provider-service').aiProviderService>

async function loadService(): Promise<AIProviderService> {
    const mod = await import('../../../../src/app/ai/ai-provider-service')
    return mod.aiProviderService(log)
}

describe('aiProviderService.listModels cache platform scoping (review #403)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
    })

    it('two platforms on the same provider keep independent cache entries', async () => {
        const service = await loadService()

        // Same provider config on two different platforms (each platform has
        // its own row; both use the OPENAI provider with the same credential).
        mockFindOneBy.mockImplementation(async ({ platformId }: { platformId: string }) => ({
            provider: AIProviderName.OPENAI,
            auth: { apiKey: 'sk-shared' },
            config: {},
            platformId,
        }))
        mockListModels.mockResolvedValue([
            { id: 'gpt-4o', name: 'gpt-4o', type: 'text-generation' },
        ])

        // Platform A warms its cache.
        const first = await service.listModels('platform-a', AIProviderName.OPENAI)
        expect(first).toHaveLength(1)
        expect(mockListModels).toHaveBeenCalledTimes(1)

        // Platform B lists - the sweep for platform B must NOT have deleted
        // platform A's entry, so platform A still gets a cache hit.
        await service.listModels('platform-b', AIProviderName.OPENAI)
        expect(mockListModels).toHaveBeenCalledTimes(2) // B's first call misses

        const again = await service.listModels('platform-a', AIProviderName.OPENAI)
        expect(mockListModels).toHaveBeenCalledTimes(2) // A hits its own entry
        expect(again[0].id).toBe('gpt-4o')
    })

    it('rotation on one platform does not evict another platform\'s entry', async () => {
        const service = await loadService()

        mockFindOneBy.mockImplementation(async ({ platformId }: { platformId: string }) => ({
            provider: AIProviderName.OPENAI,
            auth: { apiKey: platformId === 'platform-a' ? 'sk-a' : 'sk-b' },
            config: {},
            platformId,
        }))
        mockListModels.mockResolvedValue([{ id: 'm', name: 'm', type: 'text-generation' }])

        await service.listModels('platform-a', AIProviderName.OPENAI)
        await service.listModels('platform-b', AIProviderName.OPENAI)
        expect(mockListModels).toHaveBeenCalledTimes(2)

        // platform-a rotates its credential: its own old entry must be evicted
        // (new fetch), but platform-b's entry must survive (still a hit).
        mockFindOneBy.mockImplementation(async ({ platformId }: { platformId: string }) => ({
            provider: AIProviderName.OPENAI,
            auth: { apiKey: platformId === 'platform-a' ? 'sk-a-rotated' : 'sk-b' },
            config: {},
            platformId,
        }))

        await service.listModels('platform-a', AIProviderName.OPENAI)
        expect(mockListModels).toHaveBeenCalledTimes(3) // a's rotation miss

        await service.listModels('platform-b', AIProviderName.OPENAI)
        expect(mockListModels).toHaveBeenCalledTimes(3) // b still cached
    })
})
