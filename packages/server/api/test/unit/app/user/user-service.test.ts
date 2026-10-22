import { ApEdition, PlatformRole, UserStatus } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeUser = {
    id: string
    identityId: string
    platformId: string
    platformRole: PlatformRole
    status: UserStatus
    externalId?: string
    created: string
    updated: string
    lastActiveDate?: string
    identity: {
        email: string
        firstName: string
        lastName: string
        imageUrl?: string
    }
}

const buildFakeUser = (overrides: Partial<FakeUser>): FakeUser => ({
    id: 'user-1',
    identityId: 'identity-1',
    platformId: 'platform-1',
    platformRole: PlatformRole.MEMBER,
    status: UserStatus.ACTIVE,
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
    identity: {
        email: 'user1@example.com',
        firstName: 'User',
        lastName: 'One',
    },
    ...overrides,
})

const mockQueryBuilder = {
    leftJoinAndSelect: vi.fn(),
    where: vi.fn(),
}
mockQueryBuilder.leftJoinAndSelect.mockReturnValue(mockQueryBuilder)
mockQueryBuilder.where.mockReturnValue(mockQueryBuilder)

const mockUserRepo = {
    createQueryBuilder: vi.fn(() => mockQueryBuilder),
    find: vi.fn(),
    findOneOrFail: vi.fn(),
}

const mockProjectMemberRepo = {
    find: vi.fn(),
}

const mockUserIdentityRepo = {
    find: vi.fn(),
    findOneBy: vi.fn(),
    update: vi.fn(),
}

vi.mock('../../../../src/app/database/database-connection', () => ({
    databaseConnection: () => ({
        getRepository: (name: string) => {
            if (name === 'user') return mockUserRepo
            if (name === 'project_member') return mockProjectMemberRepo
            if (name === 'user_identity') return mockUserIdentityRepo
            throw new Error(`user-service.test.ts: unexpected entity "${name}"`)
        },
    }),
}))

const mockGetEdition = vi.fn()
vi.mock('../../../../src/app/helper/system/system', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/helper/system/system')>()
    return {
        ...actual,
        system: {
            ...actual.system,
            getEdition: () => mockGetEdition(),
        },
    }
})

const mockPaginate = vi.fn()
vi.mock('../../../../src/app/helper/pagination/build-paginator', () => ({
    buildPaginator: () => ({ paginate: mockPaginate }),
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

type UserService = ReturnType<typeof import('../../../../src/app/user/user-service').userService>

async function loadUserService(): Promise<UserService> {
    const mod = await import('../../../../src/app/user/user-service')
    return mod.userService(mockLog)
}

describe('userService — N+1 prevention for identity enrichment', () => {
    let service: UserService

    beforeEach(async () => {
        vi.clearAllMocks()
        vi.resetModules()
        mockQueryBuilder.leftJoinAndSelect.mockReturnValue(mockQueryBuilder)
        mockQueryBuilder.where.mockReturnValue(mockQueryBuilder)
        mockUserRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder)
        service = await loadUserService()
    })

    describe('list()', () => {
        it('joins identity in the paginated query and issues exactly one repo query for any page size', async () => {
            const fakeUsers = [
                buildFakeUser({ id: 'user-1', identity: { email: 'a@example.com', firstName: 'A', lastName: 'One' } }),
                buildFakeUser({ id: 'user-2', identity: { email: 'b@example.com', firstName: 'B', lastName: 'Two' } }),
                buildFakeUser({ id: 'user-3', identity: { email: 'c@example.com', firstName: 'C', lastName: 'Three' } }),
            ]
            mockPaginate.mockResolvedValue({ data: fakeUsers, cursor: null })

            const result = await service.list({
                platformId: 'platform-1',
                cursorRequest: null,
            })

            // Exactly one query builder is created for the whole page, regardless of row count —
            // the old implementation re-fetched the user row and its identity individually per
            // returned row (2 extra queries per row).
            expect(mockUserRepo.createQueryBuilder).toHaveBeenCalledTimes(1)
            expect(mockQueryBuilder.leftJoinAndSelect).toHaveBeenCalledWith('user.identity', 'identity')
            expect(mockUserRepo.findOneOrFail).not.toHaveBeenCalled()
            expect(mockUserIdentityRepo.findOneBy).not.toHaveBeenCalled()

            expect(result.data).toHaveLength(3)
            expect(result.data[0]).toMatchObject({ id: 'user-1', email: 'a@example.com', firstName: 'A' })
            expect(result.data[2]).toMatchObject({ id: 'user-3', email: 'c@example.com', firstName: 'C' })
        })
    })

    describe('listProjectUsers()', () => {
        it('reuses the eager-loaded identity relation instead of re-querying per user', async () => {
            mockGetEdition.mockReturnValue(ApEdition.COMMUNITY)
            mockUserRepo.find
                .mockResolvedValueOnce([buildFakeUser({ id: 'admin-1', platformRole: PlatformRole.ADMIN })]) // platform admins lookup inside getUsersForProject
                .mockResolvedValueOnce([
                    buildFakeUser({ id: 'admin-1', platformRole: PlatformRole.ADMIN, identity: { email: 'admin@example.com', firstName: 'Admin', lastName: 'User' } }),
                ]) // the eager-loaded final fetch

            const result = await service.listProjectUsers({ platformId: 'platform-1', projectId: 'project-1' })

            expect(mockUserRepo.find).toHaveBeenCalledTimes(2)
            expect(mockUserRepo.findOneOrFail).not.toHaveBeenCalled()
            expect(result).toHaveLength(1)
            expect(result[0]).toMatchObject({ id: 'admin-1', email: 'admin@example.com' })
        })
    })
})
