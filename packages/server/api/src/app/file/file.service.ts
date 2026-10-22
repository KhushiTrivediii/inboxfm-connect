import { ActivepiecesError, apId, assertNotNullOrUndefined, ErrorCode, isMultipartFile, isNil, ProjectId } from '@inboxfm-connect/core-utils'
import { File, FileCompression, FileId, FileLocation, FileType } from '@inboxfm-connect/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { In, LessThanOrEqual } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { exceptionHandler } from '../helper/exception-handler'
import { JwtAudience, JwtSignAlgorithm, jwtUtils } from '../helper/jwt-utils'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { fileCompressor } from './file-compressor'
import { FileEntity } from './file.entity'
import { s3Helper } from './s3-helper'

const ALLOWED_SIGNED_FILE_TYPES: FileType[] = [FileType.FLOW_STEP_FILE, FileType.FLOW_RUN_LOG_SLICE]

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/tiff', 'image/bmp', 'image/ico', 'image/avif', 'image/apng']

export const fileRepo = repoFactory<File>(FileEntity)
const EXECUTION_DATA_RETENTION_DAYS = system.getNumberOrThrow(AppSystemProp.EXECUTION_DATA_RETENTION_DAYS)

type BaseFile = Pick<File, 'id' | 'projectId' | 'platformId' | 'type' | 'fileName' | 'compression' | 'size' | 'metadata' | 'created' | 'updated'>

const saveFileToDb = async (baseFile: BaseFile, data: SaveParams['data']) => {
    assertNotNullOrUndefined(data, 'data is required')
    return fileRepo().save({
        ...baseFile,
        location: FileLocation.DB,
        data,
    })
}

/**
 * Atomically claims the right to write an engine file PUT and performs the write,
 * with the ownership predicate carried inside the write itself (#444, per review):
 * no check-then-write window, and no advisory lock to fail open.
 *
 *  1. Conditional update: only a row already inside the principal's scope can be
 *     rewritten. `returning` is the verdict (the PGLite driver does not populate
 *     `affected`, see #314): no returned row means "not ours" — either the id is
 *     fresh or it belongs to another tenant, and only the re-claim below may
 *     distinguish those.
 *  2. Fresh insert: for a brand-new id the primary key arbitrates concurrent
 *     first writes inside the database — `orIgnore` swallows the conflict when a
 *     racing writer committed first.
 *  3. Re-claim: a loser of that race re-runs the conditional update; the row now
 *     belongs to the winner, so 0 rows → 403. This is the exact interleaving a
 *     lock around only the guard (the first revision of this fix) left open: the
 *     second writer used to pass an absent-row check while the winner's save was
 *     still in flight and silently re-owned the row.
 */
async function saveEngineOwnedToDb(params: SaveEngineOwnedParams, baseFile: BaseFile): Promise<File> {
    const updatedIds = await claimEngineFileForUpdate(params, baseFile)
    if (updatedIds) {
        return fileRepo().findOneByOrFail({ id: params.fileId })
    }

    const insertResult = await fileRepo().createQueryBuilder()
        .insert()
        .into(FileEntity)
        .values({
            id: params.fileId,
            projectId: params.projectId,
            platformId: params.platformId,
            type: baseFile.type,
            fileName: baseFile.fileName,
            compression: baseFile.compression,
            size: baseFile.size,
            metadata: baseFile.metadata,
            created: baseFile.created,
            updated: baseFile.updated,
            data: params.data ?? undefined,
            location: FileLocation.DB,
        })
        .orIgnore()
        .returning('id')
        .execute()

    const insertedIds = insertResult.raw as Array<{ id: string }>
    if (Array.isArray(insertedIds) && insertedIds.length > 0) {
        return fileRepo().findOneByOrFail({ id: params.fileId })
    }

    // The insert was ignored because a concurrent writer committed this id first.
    // Re-claim: if that row is inside this principal's scope (an own-project retry
    // racing itself) the update succeeds; otherwise the id is someone else's file.
    const reClaimedIds = await claimEngineFileForUpdate(params, baseFile)
    if (!reClaimedIds) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'File id already exists under a different project or platform',
            },
        })
    }
    return fileRepo().findOneByOrFail({ id: params.fileId })
}

/**
 * The conditional, owner-scoped rewrite: matches only a row already inside the
 * principal's scope and returns its id on match (null when nothing matched).
 */
async function claimEngineFileForUpdate(params: SaveEngineOwnedParams, baseFile: BaseFile): Promise<Array<{ id: string }> | null> {
    const updateResult = await fileRepo().createQueryBuilder()
        .update()
        .set({
            type: baseFile.type,
            fileName: baseFile.fileName,
            compression: baseFile.compression,
            size: baseFile.size,
            metadata: baseFile.metadata,
            projectId: baseFile.projectId,
            platformId: baseFile.platformId,
            updated: baseFile.updated,
            data: params.data ?? undefined,
        })
        // The ownership predicate lives in the WHERE clause (#443): the row must
        // already be inside the principal's scope. The NULL-projectId branches are
        // deliberate — platform-scoped rows (e.g. PACKAGE_ARCHIVE) are shared
        // assets of that platform, and rows with neither scope predate scoped
        // writes; do not tighten without a migration.
        .where('("projectId" = :projectId OR ("projectId" IS NULL AND ("platformId" = :platformId OR "platformId" IS NULL))) AND "id" = :fileId', {
            fileId: params.fileId,
            projectId: params.projectId,
            platformId: params.platformId,
        })
        .returning('id')
        .execute()

    const updatedIds = updateResult.raw as Array<{ id: string }>
    return Array.isArray(updatedIds) && updatedIds.length > 0 ? updatedIds : null
}

export const fileService = (log: FastifyBaseLogger) => ({
    async save(params: SaveParams): Promise<File> {
        const baseFile: BaseFile = {
            id: params.fileId ?? apId(),
            projectId: params.projectId,
            platformId: params.platformId,
            type: params.type,
            fileName: params.fileName,
            compression: params.compression,
            size: params.size,
            metadata: params.metadata,
            created: dayjs().toISOString(),
            updated: dayjs().toISOString(),
        }
        const location = getLocationForFile(params.type)
        switch (location) {
            case FileLocation.DB: {
                return saveFileToDb(baseFile, params.data)
            }
            case FileLocation.S3: {
                try {
                    const s3Key = await s3Helper(log).constructS3Key(params.platformId, params.projectId, params.type, baseFile.id)
                    if (!isNil(params.data)) {
                        await s3Helper(log).uploadFile(s3Key, params.data)
                    }
                    const savedFile = await fileRepo().save({
                        ...baseFile,
                        location: FileLocation.S3,
                        s3Key,
                    })
                    return savedFile
                }
                catch (error) {
                    exceptionHandler.handle(error, log)
                    return saveFileToDb(baseFile, params.data)
                }
            }
        }
    },
    /**
     * Engine PUTs over caller-supplied file ids must never re-own an existing row:
     * the write itself decides whether the row is creatable/rewritable, so no
     * check-then-write window exists (#443). See {@link saveEngineOwnedToDb} for the
     * claim protocol and why the verdict is read from `returning`, not `affected`.
     */
    async saveEngineOwned(params: SaveEngineOwnedParams): Promise<File> {
        const baseFile: BaseFile = {
            id: params.fileId,
            projectId: params.projectId,
            platformId: params.platformId,
            type: params.type,
            fileName: params.fileName,
            compression: params.compression,
            size: params.size,
            metadata: params.metadata,
            created: dayjs().toISOString(),
            updated: dayjs().toISOString(),
        }
        const location = getLocationForFile(params.type)
        switch (location) {
            case FileLocation.DB: {
                return saveEngineOwnedToDb(params, baseFile)
            }
            case FileLocation.S3: {
                // S3 mode: the row must be claimed first (same predicate, no data
                // column), and only a winning claim may upload bytes and mark the row.
                // A foreign row can no longer be written to at the victim's object
                // key: the claim fails before any S3 I/O, and the loser never
                // learns the victim's s3Key.
                const claimedFile = await saveEngineOwnedToDb({
                    ...params,
                    data: null,
                }, baseFile)
                if (!isNil(params.data)) {
                    const s3Key = !isNil(claimedFile.s3Key) ? claimedFile.s3Key : await s3Helper(log).constructS3Key(params.platformId, params.projectId, params.type, params.fileId)
                    await s3Helper(log).uploadFile(s3Key, params.data)
                    return fileRepo().save({
                        ...baseFile,
                        id: claimedFile.id,
                        location: FileLocation.S3,
                        s3Key,
                    })
                }
                return fileRepo().save({
                    ...baseFile,
                    id: claimedFile.id,
                    location: FileLocation.S3,
                    s3Key: claimedFile.s3Key ?? await s3Helper(log).constructS3Key(params.platformId, params.projectId, params.type, params.fileId),
                })
            }
        }
    },
    async exists(params: GetOneParams): Promise<boolean> {
        const file = await fileRepo().findOneBy({
            projectId: params.projectId,
            id: params.fileId,
            type: normalizeTypeFilter(params.type),
        })
        return !isNil(file)
    },
    async getFile({ projectId, fileId, type }: GetOneParams): Promise<File | null> {
        const file = await fileRepo().findOneBy({
            projectId,
            id: fileId,
            type: normalizeTypeFilter(type),
        })
        return file
    },
    async getFileOrThrow(params: GetOneParams): Promise<File> {
        const file = !isNil(params.fileId) ? await this.getFile(params) : undefined
        if (isNil(file)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'file',
                    entityId: params.fileId,
                    message: 'File not found',
                },
            })
        }
        return file
    },
    async getDataOrUndefined({ projectId, fileId, type }: GetOneParams): Promise<GetDataResponse | undefined> {
        try {
            return await this.getDataOrThrow({ projectId, fileId, type })
        }
        catch (error) {
            log.error({
                error,
            }, '[FileService#getData] error')
            return undefined
        }

    },
    async getDataOrThrow({ projectId, fileId, type }: GetOneParams): Promise<GetDataResponse> {
        const file = await fileRepo().findOneBy({
            projectId,
            id: fileId,
            type: normalizeTypeFilter(type),
        })
        if (isNil(file)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'file',
                    entityId: fileId,
                    message: 'File not found',
                },
            })
        }
        const data = await fileCompressor.decompress({
            data: file.location === FileLocation.DB ? file.data : await s3Helper(log).getFile(file.s3Key!),
            compression: file.compression,
        })
        return {
            metadata: file.metadata ?? undefined,
            data,
            fileName: file.fileName ?? undefined,
        }
    },
    async delete(params: { projectId: ProjectId, fileId: FileId }): Promise<void> {
        const file = await fileRepo().findOneBy({
            id: params.fileId,
            projectId: params.projectId,
        })
        if (isNil(file)) {
            return
        }
        if (!isNil(file.s3Key)) {
            await s3Helper(log).deleteFiles([file.s3Key])
        }
        await fileRepo().delete({ id: file.id })
    },
    async deleteStaleBulk(types: FileType[]) {
        const retentionDateBoundary = dayjs().subtract(EXECUTION_DATA_RETENTION_DAYS, 'days').toISOString()
        const maximumFilesToDeletePerIteration = 4000
        const maximumFilesToDeletePerRun = 1_000_000
        let totalAffected = 0
        // Iterate one type at a time with an equality predicate so the select hits the
        // (type, created) index (idx_file_type_created_desc) as an index scan. A `type IN (...)`
        // predicate makes the planner fall back to a sequential scan of the file table (140M+ rows),
        // which, as the cleanup deletes rows, wades through dead tuples and hits statement_timeout —
        // so the cleanup never drains and the backlog grows. The delete is by primary key only.
        // Cap the work per run so a large backlog drains across the hourly schedule instead of one
        // multi-hour run (which could outlive its worker lock); the next run resumes from the oldest.
        for (const type of types) {
            let affected: undefined | number = undefined
            while ((isNil(affected) || affected === maximumFilesToDeletePerIteration) && totalAffected < maximumFilesToDeletePerRun) {
                const staleFiles = await fileRepo().find({
                    select: ['id', 's3Key'],
                    where: {
                        type,
                        created: LessThanOrEqual(retentionDateBoundary),
                    },
                    take: maximumFilesToDeletePerIteration,
                })

                if (staleFiles.length === 0) {
                    affected = 0
                    break
                }

                const s3Keys = staleFiles.filter(f => !isNil(f.s3Key)).map(f => f.s3Key!)
                await s3Helper(log).deleteFiles(s3Keys)

                const result = await fileRepo().delete({
                    id: In(staleFiles.map(file => file.id)),
                })
                affected = result.affected || 0
                totalAffected += affected
                log.info({
                    counts: affected,
                    type,
                }, '[FileService#deleteStaleBulk] iteration completed')
            }
        }
        log.info({
            totalAffected,
            types,
        }, '[FileService#deleteStaleBulk] completed')
    },
    async getFileByToken(token: string): Promise<Omit<File, 'data'>> {
        try {
            const decodedToken = await jwtUtils.decodeAndVerify<FileToken>({
                jwt: token,
                key: await jwtUtils.getJwtSecret(),
                algorithm: JwtSignAlgorithm.HS256,
                audience: JwtAudience.FILE_READ,
            })
            const fileType = decodedToken.fileType ?? FileType.FLOW_STEP_FILE
            if (!ALLOWED_SIGNED_FILE_TYPES.includes(fileType)) {
                throw new Error(`File type ${fileType} not allowed for signed download`)
            }
            return await this.getFileOrThrow({
                fileId: decodedToken.fileId,
                type: fileType,
            })
        }
        catch (e) {
            throw new ActivepiecesError({
                code: ErrorCode.INVALID_BEARER_TOKEN,
                params: {
                    message: 'invalid token or expired for the step file',
                },
            })
        }
    },
    extractBufferOrUndefined(value: unknown): Buffer | undefined {
        if (value === undefined || value === null) {
            return undefined
        }
        if (Buffer.isBuffer(value)) {
            return value
        }
        if (typeof value === 'string') {
            return Buffer.from(value, 'utf-8')
        }
        if (value instanceof Uint8Array) {
            return Buffer.from(value)
        }
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: { message: 'File data must be a Buffer' },
        })
    },
    async uploadPublicAsset(params: UploadPublicAssetParams): Promise<string | undefined> {
        const { file, type, platformId, allowedMimeTypes = IMAGE_MIME_TYPES, maxFileSizeInBytes, metadata } = params

        if (isNil(file)) {
            return undefined
        }

        if (!isMultipartFile(file)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'File must be a multipart file',
                },
            })
        }

        if (!allowedMimeTypes.includes(file.mimetype ?? '')) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `Invalid file type. Allowed types: ${allowedMimeTypes.join(', ')}`,
                },
            })
        }

        if (!isNil(maxFileSizeInBytes) && file.data.length > maxFileSizeInBytes) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `File size exceeds ${Math.round(maxFileSizeInBytes / (1024 * 1024))}MB limit`,
                },
            })
        }

        const savedFile = await this.save({
            data: file.data,
            size: file.data.length,
            type,
            compression: FileCompression.NONE,
            platformId,
            fileName: file.filename,
            metadata: {
                ...metadata,
                mimetype: file.mimetype ?? '',
            },
        })

        return `${system.get(AppSystemProp.FRONTEND_URL)}/api/v1/platforms/assets/${savedFile.id}`
    },
})

type GetDataResponse = {
    metadata?: Record<string, string>
    data: Buffer
    fileName?: string
}

function normalizeTypeFilter(type: FileType | FileType[] | undefined) {
    return Array.isArray(type) ? In(type) : type
}

export function getLocationForFile(type: FileType) {
    const FILE_LOCATION = system.getOrThrow<FileLocation>(AppSystemProp.FILE_STORAGE_LOCATION)
    if (type === FileType.FLOW_BUNDLE || isExecutionDataFileThatExpires(type)) {
        return FILE_LOCATION
    }
    return FileLocation.DB
}

function isExecutionDataFileThatExpires(type: FileType) {
    switch (type) {
        case FileType.FLOW_RUN_LOG:
        case FileType.FLOW_RUN_LOG_SLICE:
        case FileType.FLOW_STEP_FILE:
        case FileType.TRIGGER_PAYLOAD:
        case FileType.TRIGGER_EVENT_FILE:
        case FileType.WEBHOOK_PAYLOAD:
            return true
        case FileType.PLATFORM_ASSET:
        case FileType.USER_PROFILE_PICTURE:
        case FileType.SAMPLE_DATA:
        case FileType.SAMPLE_DATA_INPUT:
        case FileType.PACKAGE_ARCHIVE:
        case FileType.PROJECT_RELEASE:
        case FileType.FLOW_VERSION_BACKUP:
        case FileType.KNOWLEDGE_BASE:
            return false
        default:
            throw new Error(`File type ${type} is not supported`)
    }
}

type SaveParams = {
    fileId?: FileId | undefined
    projectId?: ProjectId
    data: Buffer | null
    size: number
    type: FileType
    platformId?: string
    fileName?: string
    compression: FileCompression
    metadata?: Record<string, string>
}

type SaveEngineOwnedParams = {
    fileId: FileId
    projectId: ProjectId
    platformId: string
    data: Buffer | null
    size: number
    type: FileType
    fileName?: string
    compression: FileCompression
    metadata?: Record<string, string>
}

type GetOneParams = {
    fileId?: FileId
    projectId?: ProjectId
    type?: FileType | FileType[]
}

type FileToken = {
    fileId: string
    fileType?: FileType
}

type UploadPublicAssetParams = {
    file: unknown
    type: FileType
    platformId: string
    allowedMimeTypes?: string[]
    maxFileSizeInBytes?: number
    metadata?: Record<string, string>
}
