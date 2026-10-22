import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDistributedStoreGet = vi.fn()
const mockDistributedStorePut = vi.fn()
const mockDistributedStoreIncr = vi.fn()

vi.mock('../../../../src/app/database/redis-connections', () => ({
    distributedStore: {
        get: (...args: unknown[]) => mockDistributedStoreGet(...args),
        put: (...args: unknown[]) => mockDistributedStorePut(...args),
        incr: (...args: unknown[]) => mockDistributedStoreIncr(...args),
    },
}))

type PieceListCache = typeof import('../../../../src/app/pieces/metadata/piece-list-cache').pieceListCache

async function loadPieceListCache(): Promise<PieceListCache> {
    const mod = await import('../../../../src/app/pieces/metadata/piece-list-cache')
    return mod.pieceListCache
}

describe('pieceListCache', () => {
    let pieceListCache: PieceListCache

    beforeEach(async () => {
        vi.clearAllMocks()
        vi.resetModules()
        pieceListCache = await loadPieceListCache()
    })

    it('reads distinct redis keys per version so a stale version never collides with the current one', async () => {
        mockDistributedStoreGet.mockResolvedValue(null)

        await pieceListCache.get('1.0.0', 3)
        await pieceListCache.get('1.0.0', 4)

        expect(mockDistributedStoreGet).toHaveBeenNthCalledWith(1, 'piece-list:1.0.0:3')
        expect(mockDistributedStoreGet).toHaveBeenNthCalledWith(2, 'piece-list:1.0.0:4')
    })

    it('defaults to version 0 when no version has ever been written', async () => {
        mockDistributedStoreGet.mockResolvedValue(null)

        const version = await pieceListCache.getVersion('1.0.0')

        expect(version).toEqual(0)
    })

    it('invalidate() bumps the version counter instead of deleting the payload key', async () => {
        await pieceListCache.invalidate('1.0.0')

        expect(mockDistributedStoreIncr).toHaveBeenCalledWith('piece-list-version:1.0.0')
    })

    it('putIfCurrent() writes the payload when the version is still current', async () => {
        mockDistributedStoreGet.mockResolvedValue(5)

        await pieceListCache.putIfCurrent('1.0.0', 5, [])

        expect(mockDistributedStorePut).toHaveBeenCalledWith('piece-list:1.0.0:5', [], expect.any(Number))
    })

    it('putIfCurrent() drops a stale write instead of resurrecting a pre-invalidation snapshot', async () => {
        // Simulates the race: a request read version 5 before starting a slow DB fetch, a
        // concurrent piece sync invalidated the cache mid-fetch (bumping the version to 6), and
        // the request's DB read (now representing pre-sync data) is only completing now.
        mockDistributedStoreGet.mockResolvedValue(6)

        await pieceListCache.putIfCurrent('1.0.0', 5, [])

        expect(mockDistributedStorePut).not.toHaveBeenCalled()
    })
})
