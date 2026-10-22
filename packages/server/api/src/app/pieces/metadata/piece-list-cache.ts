import { apDayjsDuration } from '@inboxfm-connect/server-utils'
import { distributedStore } from '../../database/redis-connections'
import { PieceMetadataSchema } from './piece-metadata-entity'

const KEY_PREFIX = 'piece-list'
const VERSION_KEY_PREFIX = 'piece-list-version'
const TEN_MINUTES_SECONDS = apDayjsDuration(10, 'minute').asSeconds()

const buildVersionKey = (currentRelease: string) => `${VERSION_KEY_PREFIX}:${currentRelease}`
const buildKey = (currentRelease: string, version: number) => `${KEY_PREFIX}:${currentRelease}:${version}`

// The cache is versioned (rather than a single fixed key) to close a stale-write race under
// concurrent piece syncs: a request that misses the cache, starts a slow DB read, and only writes
// back *after* a concurrent sync has invalidated the entry would otherwise resurrect the pre-sync
// snapshot for up to TEN_MINUTES_SECONDS. Bumping the version on invalidate() instead of deleting
// the payload key means an in-flight read for the old version can only ever write to an orphaned
// key nobody will look up again — new reads always resolve the current version first, so a late
// write can never overwrite (or reappear as) the fresh post-sync value.
export const pieceListCache = {
    async getVersion(currentRelease: string): Promise<number> {
        const version = await distributedStore.get<number>(buildVersionKey(currentRelease))
        return version ?? 0
    },
    async get(currentRelease: string, version: number): Promise<PieceMetadataSchema[] | null> {
        return distributedStore.get<PieceMetadataSchema[]>(buildKey(currentRelease, version))
    },
    async put(currentRelease: string, version: number, pieces: PieceMetadataSchema[]): Promise<void> {
        await distributedStore.put(buildKey(currentRelease, version), pieces, TEN_MINUTES_SECONDS)
    },
    async putIfCurrent(currentRelease: string, version: number, pieces: PieceMetadataSchema[]): Promise<void> {
        const latestVersion = await pieceListCache.getVersion(currentRelease)
        if (latestVersion !== version) {
            return
        }
        await pieceListCache.put(currentRelease, version, pieces)
    },
    async invalidate(currentRelease: string): Promise<void> {
        await distributedStore.incr(buildVersionKey(currentRelease))
    },
}
