import { apId, isEmpty, isNil } from '@inboxfm-connect/core-utils'
import { PackageType, PieceType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import semVer from 'semver'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { PieceRegistryEntry } from '../piece-cache'
import { PieceMetadataSchema } from '../piece-metadata-entity'
import { filePiecesUtils } from './file-pieces-utils'

export function isNewerVersion(a: string, b: string): boolean {
    const aValid = semVer.valid(a)
    const bValid = semVer.valid(b)
    if (!aValid && !bValid) {
        return a.localeCompare(b) > 0
    }
    if (!aValid) {
        return false
    }
    if (!bValid) {
        return true
    }
    return semVer.gt(a, b)
}

export function lastVersionOfEachPiece(pieces: PieceMetadataSchema[], platformId?: string): PieceMetadataSchema[] {
    const seen = new Map<string, PieceMetadataSchema>()
    for (const piece of pieces) {
        // Issue #417: dedupe by (name, platformId) scope, mirroring
        // pickLatestVersionIds' key shape. A platform-scoped custom piece may
        // share its name with an official piece (the entity's unique index is
        // (name, version, platformId)); keying by name alone silently dropped
        // the platform's piece whenever the same-name official was newer.
        const key = `${piece.name}:${piece.platformId ?? ''}`
        const existing = seen.get(key)
        if (isNil(existing) || isNewerVersion(piece.version, existing.version)) {
            seen.set(key, piece)
        }
    }
    // Review follow-up (issue #417): once the platform's own scoped entry
    // survives the dedupe, the same-name official row must NOT also appear in
    // that platform's list - the platform piece replaces the official one for
    // its platform, exactly like the per-platform view filterPieceBasedOnType
    // builds. Official rows stay for every other platform (and for the
    // platform-less view).
    if (!isNil(platformId)) {
        for (const [key, piece] of seen) {
            if (isNil(piece.platformId) && seen.has(`${piece.name}:${platformId}`)) {
                seen.delete(key)
            }
        }
    }
    return Array.from(seen.values())
}

let devPiecesCachePromise: Promise<PieceMetadataSchema[]> | null = null

export function invalidateDevPieceCache(): void {
    devPiecesCachePromise = null
}

export async function loadDevPiecesIfEnabled(log: FastifyBaseLogger): Promise<PieceMetadataSchema[]> {
    const devPiecesConfig = system.get(AppSystemProp.DEV_PIECES)
    if (isNil(devPiecesConfig) || isEmpty(devPiecesConfig)) {
        return []
    }
    if (devPiecesCachePromise) {
        return devPiecesCachePromise
    }
    devPiecesCachePromise = loadDevPieces(log, devPiecesConfig)
    devPiecesCachePromise.catch(() => {
        devPiecesCachePromise = null
    })
    return devPiecesCachePromise
}

async function loadDevPieces(log: FastifyBaseLogger, devPiecesConfig: string): Promise<PieceMetadataSchema[]> {
    const piecesNames = devPiecesConfig.split(',')
    const pieces = await filePiecesUtils(log).loadDistPiecesMetadata(piecesNames)

    return pieces.map((p): PieceMetadataSchema => ({
        id: apId(),
        ...p,
        projectUsage: 0,
        pieceType: PieceType.OFFICIAL,
        packageType: PackageType.REGISTRY,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
    }))
}

export function filterPieceBasedOnType(platformId: string | undefined, piece: PieceMetadataSchema | PieceRegistryEntry): boolean {
    return isOfficialPiece(piece) || isCustomPiece(platformId, piece)
}

export function isOfficialPiece(piece: PieceMetadataSchema | PieceRegistryEntry): boolean {
    return piece.pieceType === PieceType.OFFICIAL && isNil(piece.platformId)
}

export function isCustomPiece(platformId: string | undefined, piece: PieceMetadataSchema | PieceRegistryEntry): boolean {
    if (isNil(platformId)) {
        return false
    }
    return piece.platformId === platformId && piece.pieceType === PieceType.CUSTOM
}

export function isSupportedRelease(release: string | undefined, piece: { minimumSupportedRelease?: string, maximumSupportedRelease?: string }): boolean {
    if (isNil(release) || !semVer.valid(release)) {
        return true
    }
    if (!isNil(piece.maximumSupportedRelease) && semVer.valid(piece.maximumSupportedRelease) && semVer.compare(release, piece.maximumSupportedRelease) === 1) {
        return false
    }
    if (!isNil(piece.minimumSupportedRelease) && semVer.valid(piece.minimumSupportedRelease) && semVer.compare(release, piece.minimumSupportedRelease) === -1) {
        return false
    }
    return true
}
