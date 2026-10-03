import { PackageType, PieceCategory, PieceType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Behavioural regression (issue #475): the leaked-archive cleanup must key on whether the
// piece row was persisted, not on whether an error was thrown.
//
// pieceMetadataService.create() saves the row and *then* invalidates the piece cache. A
// cache-invalidation failure therefore propagates out of a successful insert. Cleaning up
// on "an error was thrown" would delete the archive of a piece that now exists and
// references it, leaving the piece installed but unusable.
//
// These tests drive the real installPiece() entrypoint so the ordering that matters
// (persist -> invalidate -> throw) actually happens.

const mockCreateMetadata = vi.fn()

const mockFileSave = vi.fn()
const mockFileDelete = vi.fn()
const mockS3Delete = vi.fn().mockResolvedValue(undefined)
const mockCacheInvalidate = vi.fn()

vi.mock('../../../../src/app/file/file.service', () => ({
    fileService: () => ({ save: mockFileSave }),
    fileRepo: () => ({ delete: mockFileDelete }),
}))

vi.mock('../../../../src/app/file/s3-helper', () => ({
    s3Helper: () => ({ deleteFiles: mockS3Delete }),
}))

vi.mock('../../../../src/app/pieces/metadata/piece-metadata-service', () => ({
    pieceMetadataService: () => ({ create: mockCreateMetadata }),
}))

vi.mock('../../../../src/app/pieces/metadata/piece-cache', () => ({
    pieceCache: () => ({ invalidate: mockCacheInvalidate }),
}))

vi.mock('../../../../src/app/tool-search/tool-search-flag', () => ({
    isToolSearchEnabled: () => false,
}))

vi.mock('../../../../src/app/tool-search/tool-search-reindex.job', () => ({
    toolSearchReindexJob: () => ({ enqueue: () => Promise.resolve() }),
}))

vi.mock('../../../../src/app/helper/promise-handler', () => ({
    rejectedPromiseHandler: vi.fn(),
}))

// The engine round-trip that reads a piece's metadata out of the uploaded archive.
vi.mock('../../../../src/app/helper/user-interaction/user-interaction-watcher', () => ({
    userInteractionWatcher: {
        submitAndWaitForResponse: async () => ({
            status: 'OK',
            response: {
                name: 'my-piece',
                version: '1.0.0',
                description: 'a piece',
                category: PieceCategory.UTILITY,
                author: 'someone',
                tags: [],
            },
        }),
    },
}))

const mockLog: FastifyBaseLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn(), silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

async function loadService() {
    const mod = await import('../../../../src/app/pieces/piece-install-service')
    return mod.pieceInstallService(mockLog)
}

const ARCHIVE_FILE = { id: 'archive-1', s3Key: 's3/archive-1' }

const request = {
    packageType: PackageType.ARCHIVE,
    pieceArchive: { data: Buffer.from('zip-bytes') },
} as unknown as Parameters<ReturnType<typeof loadService> extends Promise<infer T> ? T : never>['installPiece'] extends (...a: infer A) => unknown ? A[1] : never

describe('installPiece orphaned-archive cleanup (#475)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockFileSave.mockResolvedValue(ARCHIVE_FILE)
        mockS3Delete.mockResolvedValue(undefined)
        mockFileDelete.mockResolvedValue({ affected: 1 })
    })

    it('removes the archive when the piece row was never written', async () => {
        // The lost-race / duplicate case: create() rejects, so nothing references the
        // archive and it would otherwise leak forever.
        mockCreateMetadata.mockRejectedValue(new Error('23505 duplicate key'))

        const service = await loadService()
        await expect(service.installPiece('platform-1', request)).rejects.toThrow()

        expect(mockFileDelete).toHaveBeenCalledWith({ id: 'archive-1' })
        expect(mockS3Delete).toHaveBeenCalledWith(['s3/archive-1'])
    })

    it('keeps the archive when create() resolves after a cache-refresh failure', async () => {
        // The swallow itself is inside pieceMetadataService.create() (mocked here) and is
        // covered in piece-metadata-create-race.test.ts. What installPiece owes is simply:
        // a resolved create() must never trigger cleanup.
        mockCreateMetadata.mockResolvedValue({ id: 'piece-1' })

        const service = await loadService()
        await expect(service.installPiece('platform-1', request)).resolves.toMatchObject({ id: 'piece-1' })

        expect(mockFileDelete).not.toHaveBeenCalled()
        expect(mockS3Delete).not.toHaveBeenCalled()
    })

    it('keeps the archive on a clean install', async () => {
        mockCreateMetadata.mockResolvedValue({ id: 'piece-1', name: 'my-piece', version: '1.0.0' })

        const service = await loadService()
        await expect(service.installPiece('platform-1', request)).resolves.toMatchObject({ id: 'piece-1' })

        expect(mockFileDelete).not.toHaveBeenCalled()
        expect(mockS3Delete).not.toHaveBeenCalled()
    })

    it('a cleanup failure does not mask the original install error', async () => {
        mockCreateMetadata.mockRejectedValue(new Error('original failure'))
        mockFileDelete.mockRejectedValue(new Error('cleanup exploded'))

        const service = await loadService()
        // The install error is what surfaces - not the cleanup failure.
        await expect(service.installPiece('platform-1', request)).rejects.toMatchObject({
            error: {
                code: 'ENGINE_OPERATION_FAILURE',
                params: { message: 'original failure' },
            },
        })
        expect(mockLog.warn).toHaveBeenCalled()
    })

    it('touches no files for a registry install (no archive uploaded)', async () => {
        mockCreateMetadata.mockRejectedValue(new Error('23505 duplicate key'))

        const service = await loadService()
        await expect(service.installPiece('platform-1', {
            packageType: PackageType.REGISTRY,
        } as never)).rejects.toThrow()

        expect(mockFileSave).not.toHaveBeenCalled()
        expect(mockFileDelete).not.toHaveBeenCalled()
    })

    it('passes the archive id through to create() so a stored piece can load', async () => {
        mockCreateMetadata.mockResolvedValue({ id: 'piece-1' })

        const service = await loadService()
        await service.installPiece('platform-1', request)

        expect(mockCreateMetadata).toHaveBeenCalledWith(
            expect.objectContaining({ archiveId: 'archive-1', pieceType: PieceType.CUSTOM }),
        )
    })
})