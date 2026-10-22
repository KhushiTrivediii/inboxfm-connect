import { RoleType } from '@inboxfm-connect/core-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const buildRole = (id: string, name: string) => ({
    id,
    name,
    type: RoleType.CUSTOM,
    platformId: 'platform-1',
    permissions: [],
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
})

const mockProjectRoleFind = vi.fn()

const mockQueryBuilder = {
    select: vi.fn(),
    addSelect: vi.fn(),
    where: vi.fn(),
    andWhere: vi.fn(),
    groupBy: vi.fn(),
    getRawMany: vi.fn(),
}
for (const chainable of ['select', 'addSelect', 'where', 'andWhere', 'groupBy'] as const) {
    mockQueryBuilder[chainable].mockReturnValue(mockQueryBuilder)
}

const mockProjectMemberCreateQueryBuilder = vi.fn(() => mockQueryBuilder)

vi.mock('../../../../../src/app/database/database-connection', () => ({
    databaseConnection: () => ({
        getRepository: (name: string) => {
            if (name === 'project_role') return { find: mockProjectRoleFind }
            if (name === 'project_member') return { createQueryBuilder: mockProjectMemberCreateQueryBuilder }
            throw new Error(`project-role.service.test.ts: unexpected entity "${name}"`)
        },
    }),
}))

type ProjectRoleService = typeof import('../../../../../src/app/ee/projects/project-role/project-role.service').projectRoleService

async function loadProjectRoleService(): Promise<ProjectRoleService> {
    const mod = await import('../../../../../src/app/ee/projects/project-role/project-role.service')
    return mod.projectRoleService
}

describe('projectRoleService.list() — batches per-role member counts into one grouped query', () => {
    let service: ProjectRoleService

    beforeEach(async () => {
        vi.clearAllMocks()
        vi.resetModules()
        mockQueryBuilder.getRawMany.mockReset()
        for (const chainable of ['select', 'addSelect', 'where', 'andWhere', 'groupBy'] as const) {
            mockQueryBuilder[chainable].mockReturnValue(mockQueryBuilder)
        }
        service = await loadProjectRoleService()
    })

    it('issues exactly one grouped count query for any number of roles, and maps counts back by id', async () => {
        const roles = [buildRole('role-1', 'Admin'), buildRole('role-2', 'Editor'), buildRole('role-3', 'Viewer')]
        mockProjectRoleFind.mockResolvedValue(roles)
        mockQueryBuilder.getRawMany.mockResolvedValue([
            { projectRoleId: 'role-1', count: '5' },
            { projectRoleId: 'role-2', count: '2' },
            // role-3 has no members and is intentionally absent from the grouped result.
        ])

        const result = await service.list({ platformId: 'platform-1' })

        expect(mockProjectMemberCreateQueryBuilder).toHaveBeenCalledTimes(1)
        expect(mockQueryBuilder.getRawMany).toHaveBeenCalledTimes(1)

        const byId = new Map(result.data.map((role) => [role.id, role.userCount]))
        expect(byId.get('role-1')).toEqual(5)
        expect(byId.get('role-2')).toEqual(2)
        expect(byId.get('role-3')).toEqual(0)
    })

    it('skips the count query entirely when there are no roles to enrich', async () => {
        mockProjectRoleFind.mockResolvedValue([])

        const result = await service.list({ platformId: 'platform-1' })

        expect(result.data).toEqual([])
        expect(mockProjectMemberCreateQueryBuilder).not.toHaveBeenCalled()
    })
})
