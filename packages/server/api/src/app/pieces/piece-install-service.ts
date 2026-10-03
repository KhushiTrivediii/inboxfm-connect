import { ActivepiecesError, ErrorCode, isNil, PlatformId, ProjectId } from '@inboxfm-connect/core-utils'
import { PieceMetadata, PieceMetadataModel } from '@inboxfm-connect/pieces-framework'
import { AddPieceRequestBody, EngineResponse, EngineResponseStatus, ExecuteExtractPieceMetadata, File, FileCompression, FileType, PackageType, PiecePackage, PieceType, WorkerJobType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { fileRepo, fileService } from '../file/file.service'
import { s3Helper } from '../file/s3-helper'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { userInteractionWatcher } from '../helper/user-interaction/user-interaction-watcher'
import { isToolSearchEnabled } from '../tool-search/tool-search-flag'
import { toolSearchReindexJob } from '../tool-search/tool-search-reindex.job'
import { pieceMetadataService } from './metadata/piece-metadata-service'

export const pieceInstallService = (log: FastifyBaseLogger) => ({
    async installPiece(
        platformId: string,
        params: AddPieceRequestBody,
    ): Promise<PieceMetadataModel> {
        // Tracked so a failure after the archive is uploaded can remove it: if no piece row
        // was written, the archive is unreferenced and would otherwise stay in storage
        // forever - one leaked archive per failed or lost-race install.
        //
        // `piecePersisted` is the guard that matters. create() persists the row and *then*
        // invalidates the piece cache, so a cache-invalidation failure propagates out of a
        // successful insert. Cleaning up on "an error was thrown" would delete the archive of
        // a piece that exists and references it, leaving the piece unusable (issue #475).
        let uploadedArchive: File | undefined
        let piecePersisted = false
        try {
            const piecePackage = await savePiecePackage(platformId, params, log)
            uploadedArchive = piecePackage.uploadedArchive
            const pieceInformation = await extractPieceInformation({
                ...piecePackage,
                platformId,
            }, log)
            const archiveId = piecePackage.packageType === PackageType.ARCHIVE ? piecePackage.archiveId : undefined
            const savedPiece = await pieceMetadataService(log).create({
                pieceMetadata: {
                    ...pieceInformation,
                    minimumSupportedRelease:
                        pieceInformation.minimumSupportedRelease ?? '0.0.0',
                    maximumSupportedRelease:
                        pieceInformation.maximumSupportedRelease ?? '999.999.999',
                    name: pieceInformation.name,
                    version: pieceInformation.version,
                    i18n: pieceInformation.i18n,
                },
                packageType: params.packageType,
                platformId,
                pieceType: PieceType.CUSTOM,
                archiveId,
            })
            piecePersisted = true

            // Reconcile tool-search for this tenant only (async, never blocking the install) so the new
            // custom piece's actions/triggers become searchable. Scoped → the shared catalog is untouched.
            // Gated on the flag so an install never enqueues a reconcile while tool-search is disabled.
            if (isToolSearchEnabled()) {
                rejectedPromiseHandler(toolSearchReindexJob(log).enqueue({ type: 'platform', platformId }), log)
            }
            return savedPiece
        }
        catch (error) {
            log.error({ error }, '[pieceInstallService#add] Failed to add piece')

            if (!piecePersisted) {
                await deleteOrphanedArchive(uploadedArchive, log)
            }

            if (error instanceof ActivepiecesError && error.error.code === ErrorCode.VALIDATION) {
                throw error
            }
            throw new ActivepiecesError({
                code: ErrorCode.ENGINE_OPERATION_FAILURE,
                params: {
                    message: error instanceof Error ? error.message : String(error),
                },
            })
        }
    },
})


// Wraps the shared PiecePackage with the archive File this call uploaded, so a caller that
// later fails can remove it. A package archive is stored platform-scoped (projectId undefined),
// so it is unreferenced once pieceMetadataService.create() throws (issue #475).
type SavedPiecePackage = PiecePackage & { uploadedArchive?: File }

async function savePiecePackage(platformId: string | undefined, params: AddPieceRequestBody, log: FastifyBaseLogger): Promise<SavedPiecePackage> {

    switch (params.packageType) {
        case PackageType.ARCHIVE: {
            const uploadedArchive = await saveArchive({
                projectId: undefined,
                platformId,
                archive: params.pieceArchive.data as Buffer,
            }, log)
            return {
                ...params,
                pieceType: PieceType.CUSTOM,
                archiveId: uploadedArchive.id,
                uploadedArchive,
                platformId: platformId!,
                packageType: params.packageType,
            }
        }

        case PackageType.REGISTRY: {
            return {
                ...params,
                pieceType: PieceType.CUSTOM,
                platformId: platformId!,
            }
        }
    }
}

const extractPieceInformation = async (request: ExecuteExtractPieceMetadata, log: FastifyBaseLogger): Promise<PieceMetadata> => {
    const engineResponse = await userInteractionWatcher.submitAndWaitForResponse<EngineResponse<PieceMetadata>>({
        jobType: WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION,
        platformId: request.platformId,
        piece: request,
        projectId: undefined,
    }, log)

    if (engineResponse.status !== EngineResponseStatus.OK) {
        throw new Error(engineResponse.error)
    }
    return engineResponse.response
}

const saveArchive = async (
    params: GetPieceArchivePackageParams,
    log: FastifyBaseLogger,
): Promise<File> => {
    const { projectId, platformId, archive } = params

    return fileService(log).save({
        projectId: isNil(platformId) ? projectId : undefined,
        platformId,
        data: archive,
        size: archive.length,
        type: FileType.PACKAGE_ARCHIVE,
        compression: FileCompression.NONE,
    })
}

// Best-effort removal of an archive this install uploaded but never referenced. Done directly
// against the file repo rather than fileService.delete(), which filters on projectId and so
// cannot see a platform-scoped PACKAGE_ARCHIVE. A cleanup failure must never mask the install
// error that triggered it.
const deleteOrphanedArchive = async (file: File | undefined, log: FastifyBaseLogger): Promise<void> => {
    if (isNil(file)) {
        return
    }
    try {
        if (!isNil(file.s3Key)) {
            await s3Helper(log).deleteFiles([file.s3Key])
        }
        await fileRepo().delete({ id: file.id })
    }
    catch (cleanupError) {
        log.warn({ cleanupError, fileId: file.id },
            '[pieceInstallService#add] Failed to clean up orphaned piece archive')
    }
}

type GetPieceArchivePackageParams = {
    archive: Buffer
    projectId?: ProjectId
    platformId?: PlatformId
}

