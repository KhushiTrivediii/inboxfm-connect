import { InvitationStatus, InvitationType, PlatformRole } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSave = vi.fn()
const mockUpdate = vi.fn()
const mockFindOne = vi.fn()
const mockGetOne = vi.fn()
const mockGetMany = vi.fn()
const mockDelete = vi.fn()
const mockQbWhere = vi.fn()
const mockQbAndWhere = vi.fn()
const mockQbOrderBy = vi.fn()
const mockQbAddOrderBy = vi.fn()

const mockQueryBuilder = {
    where: mockQbWhere,
    andWhere: mockQbAndWhere,
    orderBy: mockQbOrderBy,
    addOrderBy: mockQbAddOrderBy,
    getOne: mockGetOne,
    getMany: mockGetMany,
}
mockQbWhere.mockReturnValue(mockQueryBuilder)
mockQbAndWhere.mockReturnValue(mockQueryBuilder)
mockQbOrderBy.mockReturnValue(mockQueryBuilder)
mockQbAddOrderBy.mockReturnValue(mockQueryBuilder)

const mockUserInvitationRepo = {
    save: mockSave,
    update: mockUpdate,
    findOne: mockFindOne,
    createQueryBuilder: vi.fn(() => mockQueryBuilder),
    delete: mockDelete,
}

vi.mock('../../../../src/app/database/database-connection', () => ({
    databaseConnection: () => ({
        getRepository: (name: string) => {
            if (name === 'user_invitation') return mockUserInvitationRepo
            throw new Error(`user-invitation-upsert.test.ts: unexpected entity "${name}"`)
        },
    }),
}))

// Fail-open lock by default (fn runs directly with lockAcquired=false),
// overridable per test. This suite exercises the convergence branches, not the
// lock infrastructure itself.
const mockRunExclusive = vi.fn()
vi.mock('../../../../src/app/database/redis-connections', () => ({
    redisConnections: {
        getRedisType: vi.fn(() => 'MEMORY'),
    },
    distributedLock: () => ({
        runExclusive: mockRunExclusive,
    }),
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

type UserInvitationsService = ReturnType<typeof import('../../../../src/app/user-invitations/user-invitation.service').userInvitationsService>

async function loadService(): Promise<UserInvitationsService> {
    const mod = await import('../../../../src/app/user-invitations/user-invitation.service')
    return mod.userInvitationsService(mockLog)
}

const winnerRow = {
    id: 'winner-id',
    platformId: 'platform-1',
    email: 'racer@example.com',
    type: InvitationType.PLATFORM,
    status: InvitationStatus.PENDING,
    projectId: null,
    projectRoleId: null,
    platformRole: null,
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
}

async function createPlatformInvitation(service: UserInvitationsService): Promise<{ id: string, platformRole: string | null }> {
    return service.create({
        email: 'racer@example.com',
        platformId: 'platform-1',
        platformRole: PlatformRole.ADMIN,
        projectId: null,
        status: InvitationStatus.PENDING,
        type: InvitationType.PLATFORM,
        projectRoleId: null,
        invitationExpirySeconds: 604800,
    })
}

describe('userInvitationsService.create() — re-invite and race convergence', () => {
    let service: UserInvitationsService

    beforeEach(async () => {
        vi.clearAllMocks()
        vi.resetModules()
        mockQbWhere.mockReturnValue(mockQueryBuilder)
        mockQbAndWhere.mockReturnValue(mockQueryBuilder)
        mockQbOrderBy.mockReturnValue(mockQueryBuilder)
        mockQbAddOrderBy.mockReturnValue(mockQueryBuilder)
        mockRunExclusive.mockImplementation(({ fn }: { fn: (params: { lockAcquired: boolean }) => Promise<unknown> }) => fn({ lockAcquired: false }))
        service = await loadService()
    })

    it('an existing invitation is updated in place, re-read after the update, and its id is preserved', async () => {
        // Natural-key lookup: the row exists (previously invited as MEMBER)
        const existingRow = { ...winnerRow, platformRole: PlatformRole.MEMBER }
        mockGetOne.mockResolvedValueOnce(existingRow)
        // getOneOrThrow re-read after the update carries the fresh values
        const reReadRow = { ...winnerRow, platformRole: PlatformRole.ADMIN }
        mockFindOne.mockResolvedValue(reReadRow)
        mockUpdate.mockResolvedValue(undefined)

        const result = await createPlatformInvitation(service)

        expect(result.id).toBe('winner-id')
        // The returned row reflects the NEW role, not the pre-update snapshot
        expect(result.platformRole).toBe(PlatformRole.ADMIN)
        expect(mockSave).not.toHaveBeenCalled()
        expect(mockUpdate).toHaveBeenCalledWith('winner-id', expect.objectContaining({
            status: InvitationStatus.PENDING,
            type: InvitationType.PLATFORM,
            platformRole: PlatformRole.ADMIN,
        }))
        // The returned row is the RE-READ, not the stale pre-update snapshot
        expect(mockFindOne).toHaveBeenCalledWith({ where: { id: 'winner-id', platformId: 'platform-1' } })
    })

    it.each([
        ['top-level code (pg shape)', Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })],
        ['driverError.code (PGLite shape — the shape the integration suite runs)', Object.assign(new Error('duplicate key value violates unique constraint'), { driverError: { code: '23505' } })],
    ])('a lost concurrent first-write (23505 on save, %s) converges on the winner row and updates it in place', async (_label, violation) => {
        // Natural-key lookup 1: no row yet. Save: loses the race.
        mockGetOne.mockResolvedValueOnce(null)
        mockSave.mockRejectedValueOnce(violation)
        // Re-read of the winner inside the convergence branch
        const winnerAsAdmin = { ...winnerRow, platformRole: PlatformRole.ADMIN }
        mockGetOne.mockResolvedValueOnce(winnerAsAdmin)
        // getOneOrThrow re-read after the update carries the fresh values
        mockFindOne.mockResolvedValue(winnerAsAdmin)
        mockUpdate.mockResolvedValue(undefined)

        const result = await createPlatformInvitation(service)

        expect(result.id).toBe('winner-id')
        // The returned row reflects the NEW role, not the winner's pre-update state
        expect(result.platformRole).toBe(PlatformRole.ADMIN)
        expect(mockUpdate).toHaveBeenCalledWith('winner-id', expect.objectContaining({
            status: InvitationStatus.PENDING,
            platformRole: PlatformRole.ADMIN,
        }))
    })

    it('a non-unique save failure propagates raw instead of masquerading as a race loss', async () => {
        mockGetOne.mockResolvedValueOnce(null)
        const dbOutage = new Error('connection refused')
        mockSave.mockRejectedValueOnce(dbOutage)

        await expect(createPlatformInvitation(service)).rejects.toThrow('connection refused')

        expect(mockUpdate).not.toHaveBeenCalled()
        expect(mockGetMany).not.toHaveBeenCalled()
    })

    it('when the lock was NOT acquired (fail-open: Redis unavailable), a PLATFORM insert prunes concurrent duplicates to the earliest row', async () => {
        // Lock infra fails BEFORE fn runs - the service's fail-open catch path
        // then invokes fn with lockAcquired=false, so the insert lands unserialized
        // and the post-insert convergence scan must fold the duplicates.
        mockRunExclusive.mockRejectedValueOnce(new Error('redis unavailable'))
        // Natural-key lookup: no row yet (both unlocked racers saw empty)
        mockGetOne.mockResolvedValueOnce(null)
        mockSave.mockResolvedValueOnce(undefined)
        // Convergence scan: two rows landed (the other racer's insert + mine)
        const mine = { ...winnerRow, id: 'mine-id', created: '2024-01-02T00:00:00.000Z' }
        mockGetMany.mockResolvedValueOnce([winnerRow, mine])
        // getOneOrThrow re-read after the prune-update
        mockFindOne.mockResolvedValue(winnerRow)
        mockUpdate.mockResolvedValue(undefined)
        mockDelete.mockResolvedValue(undefined)

        const result = await createPlatformInvitation(service)

        // Keeps the earliest row, folds the later one away
        expect(result.id).toBe('winner-id')
        expect(mockDelete).toHaveBeenCalledWith(['mine-id'])
        expect(mockUpdate).toHaveBeenCalledWith('winner-id', expect.objectContaining({
            status: InvitationStatus.PENDING,
            platformRole: PlatformRole.ADMIN,
        }))
    })

    it('when the lock WAS acquired, no convergence scan runs (the mutex already serialized the racers)', async () => {
        // Lock resolves normally: the runExclusive wrapper invokes fn with
        // lockAcquired=true, so the fail-open convergence branch is skipped.
        mockRunExclusive.mockImplementation(({ fn }: { fn: () => Promise<unknown> }) => fn())
        mockGetOne.mockResolvedValueOnce(null)
        mockSave.mockResolvedValueOnce(undefined)
        const freshRow = { ...winnerRow, id: 'fresh-id' }
        mockFindOne.mockResolvedValue(freshRow)

        await createPlatformInvitation(service)

        expect(mockGetMany).not.toHaveBeenCalled()
        expect(mockDelete).not.toHaveBeenCalled()
    })
})
