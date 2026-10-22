import {FastifyBaseLogger} from 'fastify'
import {beforeEach, describe, expect, it, vi} from 'vitest'

// Race regression (issue F29): two overlapping upserts of the same
// (externalId, scope, platformId, projectIds) used to both read "no existing
// row" and insert two rows with different apIds. The fix serializes the
// whole read-modify-write behind the distributed lock (RedLock runExclusive,
// same mutex app-connection.handler uses for token refresh), with an
// order-canonical lock key. The loser's lookup therefore runs strictly
// after the winner's commit and reuses the winner's row id.

const mockFindOneBy = vi.fn()
const mockUpsert = vi.fn()
const mockRepoFindOneByOrFail = vi.fn()

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        findOneBy: mockFindOneBy,
        upsert: mockUpsert,
        findOneByOrFail: mockRepoFindOneByOrFail,
    }),
}))

const mockRunExclusive = vi.fn()

vi.mock('../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({
        runExclusive: mockRunExclusive,
    }),
    // The engine token mint pulls in jwt-utils, which reads the redis type at
    // module load to pick its token-revocation backend.
    redisConnections: {
        getRedisType: () => 'DEFAULT',
    },
}))

vi.mock('../../../../src/app/ee/projects/project-members/project-member.service', () => ({
    projectMemberService: {},
}))
vi.mock('../../../../src/app/ee/secret-managers/secret-managers.service', () => ({
    secretManagersService: () => ({resolveObject: async ({value}: {value: unknown}) => value}),
    containsSecretManagerReference: () => false,
}))
vi.mock('../../../../src/app/helper/encryption', () => ({
    encryptUtils: {encryptObject: async (v: unknown) => v},
    EncryptedObject: {},
}))
vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {get: () => 'test'},
}))
vi.mock('../../../../src/app/pieces/metadata/piece-metadata-service', () => ({
    pieceMetadataService: () => ({getOrThrow: async () => ({version: '0.0.1'})}),
    getPiecePackageWithoutArchive: vi.fn(),
}))
vi.mock('../../../../src/app/project/project-service', () => ({
    // TypeORM countBy receives { id: In([...]), platformId } - the mock must
    // report the array length so assertProjectIds passes for any projectIds.
    projectRepo: () => ({countBy: async (where: { id?: { value?: string[] } }) => where.id?.value?.length ?? 0}),
}))
vi.mock('../../../../src/app/user/user-service', () => ({
    userService: {},
}))

const mockLog: FastifyBaseLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

type AppConnectionService = ReturnType<typeof import('../../../../src/app/app-connection/app-connection-service/app-connection-service').appConnectionService>

async function loadService(): Promise<AppConnectionService> {
    const mod = await import('../../../../src/app/app-connection/app-connection-service/app-connection-service')
    return mod.appConnectionService(mockLog)
}

// RedLock semantics: run the caller's fn under the lock, then release.
async function realRunExclusive<T>({fn}: {fn: () => Promise<T>}): Promise<T> {
    return fn()
}

const baseUpsert = {
    externalId: 'ext-1',
    pieceName: 'openai',
    displayName: 'Race Conn',
    platformId: 'platform-1',
    projectIds: ['proj-1'],
    scope: 'PROJECT',
    type: 'NO_AUTH',
    value: {type: 'NO_AUTH'},
}

describe('appConnectionService.upsert race (issue F29)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
        mockRunExclusive.mockImplementation(realRunExclusive)
    })

    it('runs the upsert lookup + write inside the distributed lock', async () => {
        const existingRow = {id: 'conn_1', externalId: 'ext-1', status: 'ACTIVE'}
        mockFindOneBy.mockResolvedValue(existingRow)
        mockUpsert.mockResolvedValue(undefined)
        mockRepoFindOneByOrFail.mockResolvedValue(existingRow)

        const service = await loadService()
        await service.upsert(baseUpsert)

        expect(mockRunExclusive).toHaveBeenCalledTimes(1)
        // The lock must cover the lookup: findOneBy is only invoked from
        // inside the locked fn (called with the lock already taken).
        const lockArgs = mockRunExclusive.mock.calls[0][0]
        expect(lockArgs.key).toContain('platform-1:ext-1:PROJECT:proj-1')
        expect(lockArgs.timeoutInSeconds).toBe(60)
        expect(mockUpsert).toHaveBeenCalledTimes(1)
        expect(mockUpsert.mock.calls[0][0].id).toBe('conn_1')
    })

    it('loser reusing the winner\'s row: lookup strictly after the winner commits', async () => {
        // With runExclusive the loser's fn only starts after the winner's fn
        // (and its upsert commit) finished and the lock was released, so the
        // loser's single lookup sees the winner's row and reuses its id.
        const winnerRow = {id: 'conn_winner', externalId: 'ext-1', status: 'ACTIVE'}
        let lockHeldByWinner = false
        mockRunExclusive.mockImplementation(async ({fn}: {fn: () => Promise<unknown>}) => {
            // Simulate the winner still holding the lock: while it is held,
            // the loser's fn must not have started (RedLock guarantees this).
            expect(lockHeldByWinner).toBe(false)
            lockHeldByWinner = true
            try {
                return await fn()
            }
            finally {
                lockHeldByWinner = false
            }
        })
        mockFindOneBy.mockResolvedValue(winnerRow)
        mockUpsert.mockResolvedValue(undefined)
        mockRepoFindOneByOrFail.mockResolvedValue(winnerRow)

        const service = await loadService()
        const result = await service.upsert(baseUpsert)

        // Exactly ONE lookup per upsert - no speculative pre-lock read that
        // could race the winner's commit.
        expect(mockFindOneBy).toHaveBeenCalledTimes(1)
        expect(mockUpsert).toHaveBeenCalledTimes(1)
        expect(mockUpsert.mock.calls[0][0].id).toBe('conn_winner')
        expect(result.id).toBe('conn_winner')
    })

    it('order-insensitive projectIds share one canonical lock key', async () => {
        // ArrayContains(['p1','p2']) matches a row saved with ['p2','p1'], so
        // permuted requests address the same connection: they must serialize
        // behind the SAME mutex, not two different lock keys.
        const row = {id: 'conn_perm', externalId: 'ext-1', status: 'ACTIVE'}
        mockFindOneBy.mockResolvedValue(row)
        mockUpsert.mockResolvedValue(undefined)
        mockRepoFindOneByOrFail.mockResolvedValue(row)

        const service = await loadService()
        await service.upsert({...baseUpsert, projectIds: ['proj-1', 'proj-2']})
        await service.upsert({...baseUpsert, projectIds: ['proj-2', 'proj-1']})

        const firstKey = mockRunExclusive.mock.calls[0][0].key
        const secondKey = mockRunExclusive.mock.calls[1][0].key
        expect(firstKey).toBe(secondKey)
        expect(firstKey).toContain('proj-1,proj-2')
    })

    it('fails open when the lock infrastructure is unavailable', async () => {
        mockRunExclusive.mockRejectedValue(new Error('ECONNREFUSED redis'))
        const row = {id: 'conn_failopen', externalId: 'ext-1', status: 'ACTIVE'}
        // After failing open the service runs fn without the lock; its lookup
        // then proceeds normally.
        mockRunExclusive.mockImplementation(realRunExclusive)
        mockRunExclusive
            .mockRejectedValueOnce(new Error('ECONNREFUSED redis'))
            .mockImplementationOnce(realRunExclusive)
        mockFindOneBy.mockResolvedValue(row)
        mockUpsert.mockResolvedValue(undefined)
        mockRepoFindOneByOrFail.mockResolvedValue(row)

        const service = await loadService()
        const result = await service.upsert(baseUpsert)

        expect(result.id).toBe('conn_failopen')
        expect(mockUpsert).toHaveBeenCalledTimes(1)
    })

    it('lock-unavailable fail-open still runs the real lookup once', async () => {
        mockRunExclusive
            .mockRejectedValueOnce(new Error('ECONNREFUSED redis'))
            .mockImplementationOnce(realRunExclusive)
        const row = {id: 'conn_x', externalId: 'ext-1', status: 'ACTIVE'}
        mockFindOneBy.mockResolvedValue(row)
        mockUpsert.mockResolvedValue(undefined)
        mockRepoFindOneByOrFail.mockResolvedValue(row)

        const service = await loadService()
        await service.upsert(baseUpsert)
        // exactly one repo lookup happened (the fail-open fn), no duplicates
        expect(mockFindOneBy).toHaveBeenCalledTimes(1)
    })

    it('errors raised by the upsert itself propagate without a fail-open retry', async () => {
        // A DB failure inside the critical section must surface - it must not
        // be mistaken for lock-unavailability and re-run (a double upsert).
        mockRunExclusive.mockImplementation(realRunExclusive)
        mockFindOneBy.mockResolvedValue(null)
        mockUpsert.mockRejectedValue(new Error('UNIQUE constraint violation'))

        const service = await loadService()
        await expect(service.upsert(baseUpsert)).rejects.toThrow('UNIQUE constraint violation')
        // The failed upsert ran exactly once - never retried via fail-open.
        expect(mockUpsert).toHaveBeenCalledTimes(1)
    })
})
