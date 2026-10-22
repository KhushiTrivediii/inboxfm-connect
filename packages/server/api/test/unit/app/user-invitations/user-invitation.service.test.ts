import { InvitationStatus, InvitationType, RoleType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const buildInvitation = (id: string, projectRoleId: string | null) => ({
    id,
    platformId: 'platform-1',
    email: `${id}@example.com`,
    type: InvitationType.PROJECT,
    status: InvitationStatus.PENDING,
    projectId: 'project-1',
    projectRoleId,
    platformRole: null,
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
})

const buildRole = (id: string, name: string) => ({
    id,
    name,
    type: RoleType.CUSTOM,
    platformId: 'platform-1',
    permissions: [],
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
})

const mockQueryBuilder = { where: vi.fn() }
mockQueryBuilder.where.mockReturnValue(mockQueryBuilder)

const mockUserInvitationRepo = { createQueryBuilder: vi.fn(() => mockQueryBuilder) }
const mockProjectRoleFind = vi.fn()

vi.mock('../../../../src/app/database/database-connection', () => ({
    databaseConnection: () => ({
        getRepository: (name: string) => {
            if (name === 'user_invitation') return mockUserInvitationRepo
            if (name === 'project_role') return { find: mockProjectRoleFind }
            throw new Error(`user-invitation.service.test.ts: unexpected entity "${name}"`)
        },
    }),
}))

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

type UserInvitationsService = ReturnType<typeof import('../../../../src/app/user-invitations/user-invitation.service').userInvitationsService>

async function loadService(): Promise<UserInvitationsService> {
    const mod = await import('../../../../src/app/user-invitations/user-invitation.service')
    return mod.userInvitationsService(mockLog)
}

describe('userInvitationsService.list() — batches project-role enrichment into one IN query', () => {
    let service: UserInvitationsService

    beforeEach(async () => {
        vi.clearAllMocks()
        vi.resetModules()
        mockQueryBuilder.where.mockReturnValue(mockQueryBuilder)
        mockUserInvitationRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder)
        service = await loadService()
    })

    it('issues exactly one repo query for the distinct project roles referenced by the whole page', async () => {
        const invitations = [
            buildInvitation('inv-1', 'role-1'),
            buildInvitation('inv-2', 'role-2'),
            buildInvitation('inv-3', 'role-1'), // same role as inv-1 — should not cause a second lookup
            buildInvitation('inv-4', null), // no project role at all
        ]
        mockPaginate.mockResolvedValue({ data: invitations, cursor: null })
        mockProjectRoleFind.mockResolvedValue([buildRole('role-1', 'Editor'), buildRole('role-2', 'Viewer')])

        const result = await service.list({
            platformId: 'platform-1',
            type: InvitationType.PROJECT,
            projectId: null,
            limit: 10,
            cursor: null,
        })

        expect(mockProjectRoleFind).toHaveBeenCalledTimes(1)
        expect(result.data).toHaveLength(4)
        const byId = new Map(result.data.map((invitation) => [invitation.id, invitation]))
        expect(byId.get('inv-1')?.projectRole).toMatchObject({ id: 'role-1', name: 'Editor' })
        expect(byId.get('inv-3')?.projectRole).toMatchObject({ id: 'role-1', name: 'Editor' })
        expect(byId.get('inv-2')?.projectRole).toMatchObject({ id: 'role-2', name: 'Viewer' })
        expect(byId.get('inv-4')?.projectRole).toBeNull()
    })

    it('skips the project-role query entirely when no invitation on the page references one', async () => {
        mockPaginate.mockResolvedValue({ data: [buildInvitation('inv-1', null)], cursor: null })

        const result = await service.list({
            platformId: 'platform-1',
            type: InvitationType.PROJECT,
            projectId: null,
            limit: 10,
            cursor: null,
        })

        expect(mockProjectRoleFind).not.toHaveBeenCalled()
        expect(result.data[0].projectRole).toBeNull()
    })
})
