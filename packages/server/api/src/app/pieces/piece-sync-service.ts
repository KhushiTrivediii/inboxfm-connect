import { apId } from '@inboxfm-connect/core-utils'
import { PieceSyncMode, PieceType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { isToolSearchEnabled } from '../tool-search/tool-search-flag'
import { toolSearchReindexJob } from '../tool-search/tool-search-reindex.job'
import { localPieceCatalog } from './metadata/local-piece-catalog'
import { pieceCache } from './metadata/piece-cache'
import { PieceMetadataSchema } from './metadata/piece-metadata-entity'
import { pieceRepos } from './metadata/piece-metadata-service'

const syncMode = system.get<PieceSyncMode>(AppSystemProp.PIECES_SYNC_MODE)

export const pieceSyncService = (log: FastifyBaseLogger) => ({
    async setup(): Promise<void> {
        rejectedPromiseHandler(pieceSyncService(log).sync({ publishCacheRefresh: false }), log)
    },
    async sync({ publishCacheRefresh }: { publishCacheRefresh: boolean }): Promise<void> {
        try {
            const dbPieces = await pieceRepos().find({
                select: {
                    name: true,
                    version: true,
                    pieceType: true,
                },
                where: {
                    pieceType: PieceType.OFFICIAL,
                },
            })

            if (syncMode === PieceSyncMode.NONE && dbPieces.length > 0) {
                log.info({ dbCount: dbPieces.length }, 'Piece sync service is set to NONE and DB already seeded')
                return
            }

            log.info('Starting local piece synchronization')
            const startTime = performance.now()
            const localPieces = localPieceCatalog.getLocalCatalog()
            log.info({ dbCount: dbPieces.length, localCount: localPieces.length }, 'Fetched pieces from DB and Local Catalog')
            const added = await installLocalPieces({
                localPieces,
                dbPieces,
                log,
                publishCacheRefresh,
            })

            log.info({
                added,
                durationMs: Math.floor(performance.now() - startTime),
            }, 'Local piece synchronization completed')

            if (added > 0 && isToolSearchEnabled()) {
                rejectedPromiseHandler(toolSearchReindexJob(log).enqueue({ type: 'all' }), log)
            }
        }
        catch (error) {
            log.error({ error }, 'Error syncing local pieces')
        }
    },
})

async function installLocalPieces({
    localPieces,
    log,
    publishCacheRefresh,
}: InstallLocalPiecesParams): Promise<number> {
    const existingDbPieces = await pieceRepos().find({
        where: { pieceType: PieceType.OFFICIAL },
    })
    const existingDbMap = new Map(existingDbPieces.map((p) => [`${p.name}:${p.version}`, p]))

    const toSave: PieceMetadataSchema[] = []
    for (const piece of localPieces) {
        const existing = existingDbMap.get(`${piece.name}:${piece.version}`)
        if (!existing) {
            toSave.push({
                ...piece,
                id: apId(),
                platformId: undefined,
                archiveId: undefined,
            })
        }
        else if (hasCatalogDrift({ existing, incoming: piece })) {
            toSave.push({
                ...existing,
                displayName: piece.displayName,
                description: piece.description,
                logoUrl: piece.logoUrl,
                categories: piece.categories,
                actions: piece.actions,
                triggers: piece.triggers,
            })
        }
    }

    if (toSave.length === 0) {
        return 0
    }

    const batchSize = 50
    for (let done = 0; done < toSave.length; done += batchSize) {
        const currentBatch = toSave.slice(done, done + batchSize)
        await pieceRepos().save(currentBatch)
    }

    log.info({ updatedCount: toSave.length }, 'Synced local pieces to database')
    if (publishCacheRefresh) {
        await pieceCache(log).invalidate()
    }
    return toSave.length
}

type PieceMetadataOnly = Pick<PieceMetadataSchema, 'name' | 'version' | 'pieceType'>

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// jsonb roundtrips reorder object keys, so raw JSON.stringify comparisons report
// phantom drift on every boot — sort keys recursively to compare canonically.
function canonicalize(value: unknown): string {
    if (isRecord(value)) {
        const entries = Object.entries(value).sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`
    }
    return JSON.stringify(value) ?? 'null'
}

// Catalog heals usually only change actions/triggers, never displayName or
// description — comparing those two fields alone leaves healed entries stuck.
function hasCatalogDrift({ existing, incoming }: HasCatalogDriftParams): boolean {
    return existing.displayName !== incoming.displayName
        || existing.description !== incoming.description
        || canonicalize(existing.actions) !== canonicalize(incoming.actions)
        || canonicalize(existing.triggers) !== canonicalize(incoming.triggers)
}

type HasCatalogDriftParams = {
    existing: PieceMetadataSchema
    incoming: PieceMetadataSchema
}

type InstallLocalPiecesParams = {
    localPieces: PieceMetadataSchema[]
    dbPieces: PieceMetadataOnly[]
    log: FastifyBaseLogger
    publishCacheRefresh: boolean
}

