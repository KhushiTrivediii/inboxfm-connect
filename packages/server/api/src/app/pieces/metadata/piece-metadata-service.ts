import { ActivepiecesError, apId, assertNotNullOrUndefined, ErrorCode, isNil, LocalesEnum, PlatformId } from '@inboxfm-connect/core-utils'
import { PieceMetadata, PieceMetadataModel, PieceMetadataModelSummary, PiecePackageInformation, pieceTranslation } from '@inboxfm-connect/pieces-framework'
import { apVersionUtil } from '@inboxfm-connect/server-utils'
import { EXACT_VERSION_REGEX, PackageType, PieceCategory, PieceOrderBy, PiecePackage, PieceSortBy, PieceType, PrivatePiecePackage, PublicPiecePackage, SuggestionType } from '@inboxfm-connect/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import semVer from 'semver'
import { EntityManager, In, IsNull } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { distributedLock } from '../../database/redis-connections'
import { pieceTagService } from '../tags/pieces/piece-tag.service'
import { localPieceCatalog } from './local-piece-catalog'
import { pieceCache, PieceRegistryEntry } from './piece-cache'
import { pieceListCache } from './piece-list-cache'
import { PieceMetadataEntity, PieceMetadataSchema } from './piece-metadata-entity'
import { filterPieceBasedOnType, isNewerVersion, isSupportedRelease, lastVersionOfEachPiece, loadDevPiecesIfEnabled, pieceListUtils } from './utils'
import { filePiecesUtils } from './utils/file-pieces-utils'
import { pieceFilteringHooks } from './utils/piece-filtering-hooks'

export const pieceRepos = repoFactory(PieceMetadataEntity)

export const pieceMetadataService = (log: FastifyBaseLogger) => {
    return {
        async setup(): Promise<void> {
            await pieceCache(log).setup()
        },
        async list(params: ListParams): Promise<PieceMetadataModelSummary[]> {
            const locale = params.locale ?? LocalesEnum.ENGLISH
            const translatedPieces = await dedupe(`list:${params.platformId ?? ''}:${locale}`, () => fetchLatestPieces({
                platformId: params.platformId,
                locale,
                log,
            }))
            const piecesWithTags = await enrichTags(params.platformId, translatedPieces, params.includeTags)
            const filteredPieces = await pieceListUtils(log).filterPieces({
                ...params,
                pieces: piecesWithTags,
                suggestionType: params.suggestionType,
            })

            return toPieceMetadataModelSummary(filteredPieces, translatedPieces, params.suggestionType)
        },
        async registry(params: RegistryParams): Promise<PiecePackageInformation[]> {
            const registry = filterRegistry(await loadRegistry(log), {
                release: params.release,
                platformId: params.platformId,
            })
            return registry.map((piece) => ({
                name: piece.name,
                version: piece.version,
            }))
        },
        async get({ projectId, platformId, version, name }: GetOrThrowParams): Promise<PieceMetadataModel | undefined> {
            const bestMatch = await findExactVersion(log, { name, version, platformId })
            if (isNil(bestMatch)) {
                return undefined
            }
            const piece = await dedupe(`piece:${bestMatch.name}:${bestMatch.version}:${bestMatch.platformId ?? ''}`, () => fetchPieceVersion({
                pieceName: bestMatch.name,
                version: bestMatch.version,
                platformId: bestMatch.platformId,
                log,
            }))

            if (isNil(piece)) {
                return undefined
            }

            const isFiltered = await pieceFilteringHooks.get(log).isFiltered({
                piece,
                projectId,
                platformId,
            })
            if (isFiltered) {
                return undefined
            }
            return piece
        },
        async getOrThrow({ version, name, platformId, locale }: GetOrThrowParams): Promise<PieceMetadataModel> {
            const piece = await this.get({ version, name, platformId })
            if (isNil(piece)) {
                throw new ActivepiecesError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        message: `piece_metadata_not_found pieceName=${name}`,
                    },
                })
            }
            if (isNil(locale) || locale === LocalesEnum.ENGLISH) {
                return piece
            }
            return pieceTranslation.translatePiece<PieceMetadataModel>({ piece, locale, mutate: false })
        },
        async updateUsage({ id, usage }: UpdateUsage): Promise<void> {
            const existingMetadata = await pieceRepos().findOneByOrFail({
                id,
            })
            await pieceRepos().update(id, {
                projectUsage: usage,
                updated: existingMetadata.updated,
                created: existingMetadata.created,
            })
        },
        async resolveExactVersion({ name, version, platformId }: GetExactPieceVersionParams): Promise<string> {
            const isExactVersion = EXACT_VERSION_REGEX.test(version)

            if (isExactVersion) {
                return version
            }

            const pieceMetadata = await this.getOrThrow({
                name,
                version,
                platformId,
            })

            return pieceMetadata.version
        },
        async create({
            pieceMetadata,
            platformId,
            packageType,
            pieceType,
            archiveId,
            publishCacheRefresh = true,
        }: CreateParams): Promise<PieceMetadataSchema> {
            // Serialize the existence-check + insert on the natural key
            // (name, version, platformId). Without this, two concurrent installs of the same
            // version - a double-clicked dashboard install, an admin retry, two replicas
            // handling the same provisioning action, or the project-replace deploy loop
            // racing a manual install - both pass the check and both insert, and the loser
            // hits idx_piece_metadata_name_platform_id_version as a raw driver error.
            //
            // In-lock the re-check still arbitrates, so a caller that genuinely raced still
            // gets the same clean piece_metadata_already_exists VALIDATION error rather than
            // a constraint string wrapped as ENGINE_OPERATION_FAILURE.
            const lockKey = [
                'piece-metadata',
                'create',
                platformId ?? 'no-platform',
                pieceMetadata.name,
                pieceMetadata.version,
            ].join(':')

            return distributedLock(log).runExclusive({
                key: lockKey,
                timeoutInSeconds: 60,
                fn: async () => {
                    const existingMetadata = await pieceRepos().findOneBy({
                        name: pieceMetadata.name,
                        version: pieceMetadata.version,
                        platformId: platformId ?? IsNull(),
                    })
                    if (!isNil(existingMetadata)) {
                        throw new ActivepiecesError({
                            code: ErrorCode.VALIDATION,
                            params: {
                                message: `piece_metadata_already_exists name=${pieceMetadata.name} version=${pieceMetadata.version}`,
                            },
                        })
                    }
                    const createdDate = await findOldestCreatedDate({
                        name: pieceMetadata.name,
                        platformId,
                    })
                    const savedPiece = await pieceRepos().save({
                        ...pickArchiveControlledMetadata(pieceMetadata),
                        id: apId(),
                        packageType,
                        pieceType,
                        archiveId,
                        platformId,
                        created: createdDate,
                    })
                    if (publishCacheRefresh) {
                        // The row is already committed at this point, so a cache refresh
                        // failure must not fail the install. Propagating it makes the caller
                        // believe the insert rolled back, and any compensating cleanup then
                        // deletes the archive this saved row references - leaving an
                        // installed piece that cannot load (issue #475).
                        // The cache is derived state, so staleness self-heals; log loudly.
                        try {
                            await pieceCache(log).invalidate()
                        }
                        catch (cacheError) {
                            // No piece id in the log: `savedPiece` is typed as an intersection
                            // that TS reduces to `never` (packageType conflicts between the
                            // explicit fields and ...pieceMetadata), so reading `.id` off it
                            // does not typecheck. The name/version pair identifies the row and
                            // are plain strings off the request.
                            log.error({ cacheError, name: pieceMetadata.name, version: pieceMetadata.version },
                                '[pieceMetadataService#create] Piece cache refresh failed; the piece is installed')
                        }
                    }
                    return savedPiece
                },
            })
        },

        async bulkDelete(pieces: { name: string, version: string }[]): Promise<void> {
            const results = await Promise.all(pieces.map((piece) =>
                pieceRepos().delete({ name: piece.name, version: piece.version }),
            ))
            const anyDeleted = results.some((result) => !isNil(result.affected) && result.affected > 0)
            if (anyDeleted) {
                await pieceCache(log).invalidate()
            }
        },

        async delete({ id, platformId }: DeleteParams): Promise<void> {
            const piece = await pieceRepos().findOneBy({ id })
            if (isNil(piece) || piece.platformId !== platformId) {
                throw new ActivepiecesError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: { entityType: 'piece', entityId: id },
                })
            }
            if (piece.pieceType !== PieceType.CUSTOM) {
                throw new ActivepiecesError({
                    code: ErrorCode.AUTHORIZATION,
                    params: { message: 'Only custom pieces can be deleted' },
                })
            }
            await pieceRepos().delete({ name: piece.name, platformId, pieceType: PieceType.CUSTOM })
            await pieceCache(log).invalidate()
        },
    }
}

export const getPiecePackageWithoutArchive = async (
    log: FastifyBaseLogger,
    platformId: PlatformId | undefined,
    pkg: Omit<PublicPiecePackage, 'directoryPath' | 'pieceType' | 'packageType'> | Omit<PrivatePiecePackage, 'archiveId' | 'archive' | 'pieceType' | 'packageType'>,
): Promise<PiecePackage> => {
    const pieceMetadata = await pieceMetadataService(log).getOrThrow({
        name: pkg.pieceName,
        version: pkg.pieceVersion,
        platformId,
    })
    switch (pieceMetadata.packageType) {
        case PackageType.ARCHIVE:
            assertNotNullOrUndefined(pieceMetadata.platformId, 'platformId is required')
            return {
                pieceName: pieceMetadata.name,
                pieceVersion: pieceMetadata.version,
                pieceType: pieceMetadata.pieceType,
                packageType: pieceMetadata.packageType,
                archiveId: pieceMetadata.archiveId!,
                platformId: pieceMetadata.platformId,
            }
        case PackageType.REGISTRY: {
            const piecePlatformId = pieceMetadata.platformId
            if (pieceMetadata.pieceType === PieceType.CUSTOM) {
                assertNotNullOrUndefined(piecePlatformId, 'platformId is required')
                return {
                    pieceName: pieceMetadata.name,
                    pieceVersion: pieceMetadata.version,
                    packageType: pieceMetadata.packageType,
                    pieceType: pieceMetadata.pieceType,
                    platformId: piecePlatformId,
                }
            }
            return {
                pieceName: pieceMetadata.name,
                pieceVersion: pieceMetadata.version,
                packageType: pieceMetadata.packageType,
                pieceType: pieceMetadata.pieceType,
            }
        }
        default: {
            throw new Error(`Unhandled packageType: ${(pieceMetadata as { packageType: string }).packageType}`)
        }
    }
}

export function toPieceMetadataModelSummary<T extends PieceMetadataSchema | PieceMetadataModel>(
    pieceMetadataEntityList: T[],
    originalMetadataList: T[],
    suggestionType?: SuggestionType,
): PieceMetadataModelSummary[] {
    return pieceMetadataEntityList.map((pieceMetadataEntity) => {
        const originalMetadata = originalMetadataList.find((p) => p.name === pieceMetadataEntity.name)
        assertNotNullOrUndefined(originalMetadata, `Original metadata not found for ${pieceMetadataEntity.name}`)
        return {
            ...pieceMetadataEntity,
            actions: Object.keys(originalMetadata.actions).length,
            triggers: Object.keys(originalMetadata.triggers).length,
            suggestedActions: suggestionType === SuggestionType.ACTION || suggestionType === SuggestionType.ACTION_AND_TRIGGER ?
                Object.values(pieceMetadataEntity.actions) : undefined,
            suggestedTriggers: suggestionType === SuggestionType.TRIGGER || suggestionType === SuggestionType.ACTION_AND_TRIGGER ?
                Object.values(pieceMetadataEntity.triggers) : undefined,
        }
    })
}

/**
 * Whitelist of piece-metadata keys an installed archive may control.
 *
 * `create()` persists whatever the caller hands it, and for archive installs
 * that object comes from the engine running attacker-supplied JavaScript
 * (`piece.metadata()` — `extractPieceFromModule` only checks the exported
 * constructor's name before trusting it). Spreading that object last let a
 * crafted archive override the server-pinned columns (platformId, pieceType,
 * packageType, id, created) and plant a NULL-platformId OFFICIAL row in the
 * global catalog — visible to every platform and impossible to delete
 * (`delete()` only removes CUSTOM rows for the caller's platformId).
 *
 * Only piece-content keys are taken from the archive; every server-pinned
 * column is assigned by `create()` itself after the spread.
 */
const ARCHIVE_CONTROLLED_METADATA_KEYS = [
    'name',
    'version',
    'displayName',
    'logoUrl',
    'description',
    'authors',
    'categories',
    'auth',
    'actions',
    'triggers',
    'i18n',
    'minimumSupportedRelease',
    'maximumSupportedRelease',
] as const

export function pickArchiveControlledMetadata(metadata: PieceMetadata): Pick<PieceMetadata, typeof ARCHIVE_CONTROLLED_METADATA_KEYS[number]> {
    const picked: Record<string, unknown> = {}
    for (const key of ARCHIVE_CONTROLLED_METADATA_KEYS) {
        // Preserve explicit nulls (an archive legitimately declaring "no auth"
        // persists NULL the same way dev's raw spread did) — only absent keys
        // are dropped. The whitelist is key-selection, not value-filtering.
        if (metadata[key] !== undefined) {
            picked[key] = metadata[key]
        }
    }
    return picked as Pick<PieceMetadata, typeof ARCHIVE_CONTROLLED_METADATA_KEYS[number]>
}

const findOldestCreatedDate = async ({ name, platformId }: { name: string, platformId?: string }): Promise<string> => {
    const piece = await pieceRepos().findOne({
        where: {
            name,
            platformId: platformId ?? IsNull(),
        },
        order: {
            created: 'ASC',
        },
    })
    return piece?.created ?? dayjs().toISOString()
}

const enrichTags = async (platformId: string | undefined, pieces: PieceMetadataSchema[], includeTags: boolean | undefined): Promise<PieceMetadataSchema[]> => {
    if (!includeTags || isNil(platformId)) {
        return pieces
    }
    const tags = await pieceTagService.findByPlatform(platformId)
    return pieces.map((piece) => {
        return {
            ...piece,
            tags: tags[piece.name] ?? [],
        }
    })
}

const sortByVersionDescending = <T extends { version: string }>(a: T, b: T): number => {
    const aValid = semVer.valid(a.version)
    const bValid = semVer.valid(b.version)
    if (!aValid && !bValid) {
        return b.version.localeCompare(a.version)
    }
    if (!aValid) {
        return 1
    }
    if (!bValid) {
        return -1
    }
    return semVer.rcompare(a.version, b.version)
}

const findExactVersion = async (
    log: FastifyBaseLogger,
    params: { name: string, version: string | undefined, platformId: string | undefined },
): Promise<{ name: string, version: string, platformId: string | undefined } | undefined> => {
    const { name, version, platformId } = params
    const versionToSearch = findNextExcludedVersion(version)
    const currentRelease = apVersionUtil.getCurrentRelease()
    const registry = filterRegistry(await loadRegistry(log), { release: currentRelease, platformId })
    const cleanTarget = localPieceCatalog.normalizePieceName(name)
    const matchingRegistryEntries = registry.filter((entry) => {
        const cleanEntry = localPieceCatalog.normalizePieceName(entry.name)
        if (entry.name !== name && cleanEntry !== cleanTarget) {
            return false
        }
        if (isNil(versionToSearch)) {
            return true
        }
        return semVer.compare(entry.version, versionToSearch.nextExcludedVersion) < 0
            && semVer.compare(entry.version, versionToSearch.baseVersion) >= 0
    })

    if (matchingRegistryEntries.length === 0) {
        return undefined
    }

    const sortedEntries = matchingRegistryEntries.sort(sortByVersionDescending)
    return {
        name: sortedEntries[0].name,
        version: sortedEntries[0].version,
        platformId: sortedEntries[0].platformId,
    }
}

const findNextExcludedVersion = (version: string | undefined): { baseVersion: string, nextExcludedVersion: string } | undefined => {
    if (version?.startsWith('^')) {
        const baseVersion = version.substring(1)
        return {
            baseVersion,
            nextExcludedVersion: increaseMajorVersion(baseVersion),
        }
    }
    if (version?.startsWith('~')) {
        const baseVersion = version.substring(1)
        return {
            baseVersion,
            nextExcludedVersion: increaseMinorVersion(baseVersion),
        }
    }
    if (isNil(version)) {
        return undefined
    }
    return {
        baseVersion: version,
        nextExcludedVersion: increasePatchVersion(version),
    }
}

const increasePatchVersion = (version: string): string => {
    const incrementedVersion = semVer.inc(version, 'patch')
    if (isNil(incrementedVersion)) {
        throw new Error(`Failed to increase patch version ${version}`)
    }
    return incrementedVersion
}

const increaseMinorVersion = (version: string): string => {
    const incrementedVersion = semVer.inc(version, 'minor')
    if (isNil(incrementedVersion)) {
        throw new Error(`Failed to increase minor version ${version}`)
    }
    return incrementedVersion
}

const increaseMajorVersion = (version: string): string => {
    const incrementedVersion = semVer.inc(version, 'major')
    if (isNil(incrementedVersion)) {
        throw new Error(`Failed to increase major version ${version}`)
    }
    return incrementedVersion
}

async function fetchLatestPieces({ platformId, locale = LocalesEnum.ENGLISH, log }: FetchLatestPiecesParams): Promise<PieceMetadataSchema[]> {
    const currentRelease = apVersionUtil.getCurrentRelease()

    const latestPiecesFromDb = await dedupe(`latest-pieces:${currentRelease}`, () => fetchLatestCompatiblePiecesFromDB(currentRelease))
    const localPieces = localPieceCatalog.getLocalCatalog()
    const dbPieceNames = new Set(latestPiecesFromDb.map((p) => p.name))
    const missingFromLocal = localPieces.filter((p) => !dbPieceNames.has(p.name))
    const latestPieces = [...latestPiecesFromDb, ...missingFromLocal]
    const translatedPieces = translatePieces(latestPieces, locale)

    const devPieces = await loadDevPiecesIfEnabled(log)
    const translatedDevPieces = devPieces.map((piece) =>
        pieceTranslation.translatePiece<PieceMetadataSchema>({ piece, locale, mutate: true }),
    )

    const devPieceNames = new Set(translatedDevPieces.map((p) => p.name))
    const merged = [...translatedPieces.filter((p) => !devPieceNames.has(p.name)), ...translatedDevPieces]
        .filter((piece) => filterPieceBasedOnType(platformId, piece))
        .filter((piece) => isSupportedRelease(currentRelease, piece))
    return lastVersionOfEachPiece(merged, platformId)
}

async function fetchPieceVersion({ pieceName, version, platformId, log }: FetchPieceVersionParams): Promise<PieceMetadataSchema | null> {
    const devPieces = await loadDevPiecesIfEnabled(log)
    const cleanName = localPieceCatalog.normalizePieceName(pieceName)
    const devPiece = devPieces.find((p) => (p.name === pieceName || localPieceCatalog.normalizePieceName(p.name) === cleanName) && (isNil(version) || p.version === version))
    if (!isNil(devPiece)) {
        return devPiece
    }

    const whereConditions = [
        { name: pieceName, platformId: platformId ?? IsNull() },
        { name: `@inboxfm-connect/piece-${cleanName}`, platformId: platformId ?? IsNull() },
        { name: `@activepieces/piece-${cleanName}`, platformId: platformId ?? IsNull() },
        { name: cleanName, platformId: platformId ?? IsNull() },
    ].map((cond) => (isNil(version) ? cond : { ...cond, version }))

    const foundPiece = await pieceRepos().findOne({
        where: whereConditions,
    })
    if (!isNil(foundPiece)) {
        return foundPiece
    }

    // Attempt to load rich compiled piece from dist folder if available
    const compiledPieces = await filePiecesUtils(log).loadDistPiecesMetadata([cleanName]).catch(() => [])
    if (compiledPieces.length > 0) {
        const compiled = compiledPieces[0]
        return {
            id: apId(),
            ...compiled,
            projectUsage: 0,
            pieceType: PieceType.OFFICIAL,
            packageType: PackageType.REGISTRY,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        }
    }

    const localPiece = localPieceCatalog.findLocalPiece({ name: pieceName, version })
    if (!isNil(localPiece)) {
        return localPiece
    }

    return null
}

export async function fetchLatestCompatiblePiecesFromDB(currentRelease: string): Promise<PieceMetadataSchema[]> {
    const version = await pieceListCache.getVersion(currentRelease)
    const cached = await pieceListCache.get(currentRelease, version)
    if (!isNil(cached)) {
        return cached
    }

    const allKeys = await pieceRepos()
        .createQueryBuilder('pm')
        .select(['pm."id"', 'pm."name"', 'pm."version"', 'pm."platformId"', 'pm."minimumSupportedRelease"', 'pm."maximumSupportedRelease"'])
        .getRawMany<PieceKey>()

    const compatibleKeys = allKeys.filter((piece) => isSupportedRelease(currentRelease, piece))
    const latestIds = pickLatestVersionIds(compatibleKeys)
    const pieces = latestIds.length > 0 ? await pieceRepos().find({ where: { id: In(latestIds) } }) : []

    // Only cache under the version read at the start of this fetch. If a concurrent sync bumped
    // the version while this DB read was in flight, `version` is already stale — writing it back
    // would resurrect data that predates the invalidation. See piece-list-cache.ts for the full
    // race this guards against.
    await pieceListCache.putIfCurrent(currentRelease, version, pieces)
    return pieces
}

function pickLatestVersionIds(pieces: PieceKey[]): string[] {
    const latest = new Map<string, PieceKey>()
    for (const piece of pieces) {
        const key = `${piece.name}:${piece.platformId ?? ''}`
        const existing = latest.get(key)
        if (isNil(existing) || isNewerVersion(piece.version, existing.version)) {
            latest.set(key, piece)
        }
    }
    return Array.from(latest.values()).map((p) => p.id)
}

function translatePieces(pieces: PieceMetadataSchema[], locale: LocalesEnum): PieceMetadataSchema[] {
    return pieces.map((piece) => {
        const translated = locale === LocalesEnum.ENGLISH
            ? { ...piece }
            : pieceTranslation.translatePiece<PieceMetadataSchema>({ piece, locale, mutate: false })
        translated.i18n = undefined
        return translated
    })
}

const inflightFetches = new Map<string, Promise<unknown>>()

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inflightFetches.get(key) as Promise<T> | undefined
    if (!isNil(existing)) {
        return existing
    }
    const promise = (async () => {
        try {
            return await fn()
        }
        finally {
            inflightFetches.delete(key)
        }
    })()
    inflightFetches.set(key, promise)
    return promise
}

function loadRegistry(log: FastifyBaseLogger): Promise<PieceRegistryEntry[]> {
    return dedupe('registry-load', () => pieceCache(log).loadRegistry())
}

function filterRegistry(registry: PieceRegistryEntry[], params: { release: string | undefined, platformId: string | undefined }): PieceRegistryEntry[] {
    return registry
        .filter((piece) => filterPieceBasedOnType(params.platformId, piece))
        .filter((piece) => isNil(params.release) || isSupportedRelease(params.release, piece))
}


// Types

type ListParams = {
    projectId?: string
    platformId?: string
    includeHidden: boolean
    categories?: PieceCategory[]
    includeTags?: boolean
    tags?: string[]
    sortBy?: PieceSortBy
    orderBy?: PieceOrderBy
    searchQuery?: string
    suggestionType?: SuggestionType
    locale?: LocalesEnum
}

type GetOrThrowParams = {
    name: string
    version?: string
    entityManager?: EntityManager
    projectId?: string
    platformId?: string
    locale?: LocalesEnum
}

type DeleteParams = {
    id: string
    platformId: string
}



type CreateParams = {
    pieceMetadata: PieceMetadata
    platformId?: string
    projectId?: string
    packageType: PackageType
    pieceType: PieceType
    archiveId?: string
    publishCacheRefresh?: boolean
}

type UpdateUsage = {
    id: string
    usage: number
}

type GetExactPieceVersionParams = {
    name: string
    version: string
    platformId: PlatformId
}

type RegistryParams = {
    release: string
    platformId?: string
}

type FetchLatestPiecesParams = {
    platformId?: string
    locale?: LocalesEnum
    log: FastifyBaseLogger
}

type FetchPieceVersionParams = {
    pieceName: string
    version: string
    platformId?: string
    log: FastifyBaseLogger
}

type PieceKey = {
    id: string
    name: string
    version: string
    platformId: string | null
    minimumSupportedRelease?: string
    maximumSupportedRelease?: string
}

