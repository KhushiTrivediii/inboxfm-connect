import { PackageType, PieceType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Race + leak regression (issue #475): pieceMetadataService.create() was
// find-then-insert against idx_piece_metadata_name_platform_id_version:
//
//   findOneBy({ name, version, platformId })  // existence check
//   findOldestCreatedDate(...)                 // a second read
//   pieceRepos().save(...)                     // the insert
//
// No lock, no unique-violation handling. Two concurrent installs of the same
// (name, version, platformId) - a double-clicked dashboard install, an admin retry,
// two replicas handling the same provisioning action - both passed the check and both
// inserted. The loser's 23505 propagated into installPiece's catch and was re-wrapped
// as ENGINE_OPERATION_FAILURE, blaming the engine for a plain duplicate request.
//
// Second half of the issue: the loser's archive was uploaded via fileService.save()
// *before* create() threw, so that file row plus its stored bytes were unreachable and
// stayed in storage forever - one leaked archive per lost race.
//
// The fix serializes create() on the natural key behind the distributed lock, and the
// install path removes an archive it uploaded but never referenced.

const mockFindOneBy = vi.fn()
const mockFindOne = vi.fn()
const mockSave = vi.fn()
const mockCreateQueryBuilder = vi.fn()

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        findOneBy: mockFindOneBy,
        findOne: mockFindOne,
        save: mockSave,
        createQueryBuilder: mockCreateQueryBuilder,
    }),
}))

vi.mock('../../../../src/app/pieces/metadata/piece-cache', () => ({
    pieceCache: () => ({ invalidate: vi.fn().mockResolvedValue(undefined) }),
    PieceRegistryEntry: {},
}))

vi.mock('../../../../src/app/pieces/metadata/piece-list-cache', () => ({
    pieceListCache: () => ({}),
}))

vi.mock('../../../../src/app/pieces/tags/pieces/piece-tag.service', () => ({
    pieceTagService: () => ({}),
}))

vi.mock('../../../../src/app/pieces/metadata/local-piece-catalog', () => ({
    localPieceCatalog: () => ({}),
}))

vi.mock('../../../../src/app/pieces/metadata/utils', () => ({
    filterPieceBasedOnType: vi.fn(),
    isNewerVersion: vi.fn(),
    isSupportedRelease: vi.fn(),
    lastVersionOfEachPiece: vi.fn(),
    loadDevPiecesIfEnabled: vi.fn(),
    pieceListUtils: {},
}))

vi.mock('../../../../src/app/pieces/metadata/utils/file-pieces-utils', () => ({
    filePiecesUtils: {},
}))

vi.mock('../../../../src/app/pieces/metadata/utils/piece-filtering-hooks', () => ({
    pieceFilteringHooks: {},
}))

// Capture the lock key so the serialization can be asserted directly.
const takenLockKeys: string[] = []

vi.mock('../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({
        runExclusive: ({ key, fn }: { key: string, fn: () => Promise<unknown> }) => {
            takenLockKeys.push(key)
            return fn()
        },
    }),
}))

const mockLog: FastifyBaseLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn(), silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

async function loadService() {
    const mod = await import('../../../../src/app/pieces/metadata/piece-metadata-service')
    return mod.pieceMetadataService(mockLog)
}

const pieceMetadata = {
    name: 'my-piece',
    version: '1.0.0',
    description: 'a piece',
    category: 'UTILITY' as never,
    author: 'someone',
    tags: [],
    i18n: {} as never,
    createdBy: '',
}

async function createPiece(service: Awaited<ReturnType<typeof loadService>>, platformId?: string) {
    return service.create({
        pieceMetadata,
        packageType: PackageType.ARCHIVE,
        platformId,
        pieceType: PieceType.CUSTOM,
        archiveId: 'archive-1',
        publishCacheRefresh: false,
    })
}

describe('pieceMetadataService.create race (#475)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        takenLockKeys.length = 0
        mockFindOneBy.mockResolvedValue(null)
        // findOldestCreatedDate() reads the earliest row for the piece name.
        mockFindOne.mockResolvedValue({ created: '2026-01-01T00:00:00.000Z' })
        mockSave.mockImplementation(async (entity) => ({ id: 'piece-1', ...entity }))
    })

    it('serializes create on the (name, version, platformId) natural key', async () => {
        const service = await loadService()
        await createPiece(service, 'platform-1')

        // Without a lock, two concurrent installs both pass the existence check.
        expect(takenLockKeys).toEqual([
            'piece-metadata:create:platform-1:my-piece:1.0.0',
        ])
    })

    it('uses a distinct lock key per piece version', async () => {
        const service = await loadService()
        await createPiece(service, 'platform-1')
        await service.create({
            pieceMetadata: { ...pieceMetadata, version: '2.0.0' },
            packageType: PackageType.ARCHIVE,
            platformId: 'platform-1',
            pieceType: PieceType.CUSTOM,
            archiveId: 'archive-2',
            publishCacheRefresh: false,
        })

        // Two versions are two different rows, so they must not share one mutex.
        expect(takenLockKeys).toHaveLength(2)
        expect(takenLockKeys[0]).not.toBe(takenLockKeys[1])
    })

    it('re-checks inside the lock so a raced second install gets the clean validation error', async () => {
        const service = await loadService()
        // The winner's row is visible by the time the loser's in-lock check runs.
        mockFindOneBy.mockResolvedValue({ id: 'piece-1' })

        await expect(createPiece(service, 'platform-1')).rejects.toMatchObject({
            error: { code: 'VALIDATION' },
        })
        expect(mockSave).not.toHaveBeenCalled()
    })

    it('still installs cleanly when nothing is racing', async () => {
        const service = await loadService()
        await expect(createPiece(service, 'platform-1')).resolves.toMatchObject({
            name: 'my-piece',
            version: '1.0.0',
        })
        expect(mockSave).toHaveBeenCalledTimes(1)
    })

    it('does not rewrite the primary key of an existing row', async () => {
        const service = await loadService()
        await createPiece(service, 'platform-1')

        const [saved] = mockSave.mock.calls[0]
        // The insert always carries a fresh id; the unique index decides the winner, so the
        // losing insert must never overwrite the winner's primary key.
        expect(saved.id).toBeTruthy()
        expect(saved.name).toBe('my-piece')
    })

    it('uses a platform-less lock key for community pieces', async () => {
        const service = await loadService()
        await createPiece(service, undefined)

        expect(takenLockKeys).toEqual(['piece-metadata:create:no-platform:my-piece:1.0.0'])
    })
})