import { ProjectType, ScimGroupResource } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const buildProject = (id: string) => ({
    id,
    displayName: `Project ${id}`,
    externalId: `ext-${id}`,
    platformId: 'platform-1',
    type: ProjectType.TEAM,
    created: '2024-01-01T00:00:00.000Z',
    updated: '2024-01-01T00:00:00.000Z',
})

const buildMember = (projectId: string, userId: string) => ({
    id: `member-${projectId}-${userId}`,
    projectId,
    userId,
    platformId: 'platform-1',
})

const buildUser = (id: string, email: string) => ({
    id,
    platformId: 'platform-1',
    identityId: `identity-${id}`,
    identity: { email, firstName: 'First', lastName: 'Last' },
})

const mockGetAllForUser = vi.fn()
vi.mock('../../../../../src/app/project/project-service', () => ({
    projectService: () => ({
        getAllForUser: mockGetAllForUser,
    }),
}))

const mockProjectMemberFind = vi.fn()
const mockUserFind = vi.fn()

vi.mock('../../../../../src/app/database/database-connection', () => ({
    databaseConnection: () => ({
        getRepository: (name: string) => {
            if (name === 'project_member') return { find: mockProjectMemberFind }
            if (name === 'user') return { find: mockUserFind }
            throw new Error(`scim-group-service.test.ts: unexpected entity "${name}"`)
        },
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

type ScimGroupService = ReturnType<typeof import('../../../../../src/app/ee/scim/scim-group-service').scimGroupService>

async function loadScimGroupService(): Promise<ScimGroupService> {
    const mod = await import('../../../../../src/app/ee/scim/scim-group-service')
    return mod.scimGroupService(mockLog)
}

describe('scimGroupService.list() — batches member/user lookups across the whole page', () => {
    let service: ScimGroupService

    beforeEach(async () => {
        vi.clearAllMocks()
        vi.resetModules()
        service = await loadScimGroupService()
    })

    it('issues exactly one project-member query and one user query for a page of multiple groups', async () => {
        const projects = [buildProject('project-1'), buildProject('project-2'), buildProject('project-3')]
        mockGetAllForUser.mockResolvedValue(projects)
        mockProjectMemberFind.mockResolvedValue([
            buildMember('project-1', 'user-1'),
            buildMember('project-1', 'user-2'),
            buildMember('project-2', 'user-2'),
            buildMember('project-3', 'user-3'),
        ])
        mockUserFind.mockResolvedValue([
            buildUser('user-1', 'user1@example.com'),
            buildUser('user-2', 'user2@example.com'),
            buildUser('user-3', 'user3@example.com'),
        ])

        const result = await service.list({ platformId: 'platform-1' })

        // One query for every project's members and one batched query for every distinct member's
        // user meta — not one pair of queries per returned group (which was the previous behavior).
        expect(mockProjectMemberFind).toHaveBeenCalledTimes(1)
        expect(mockUserFind).toHaveBeenCalledTimes(1)

        const resources = result.Resources.map((resource) => ScimGroupResource.parse(resource))
        expect(resources).toHaveLength(3)
        const group1 = resources.find((r) => r.id === 'project-1')
        const group2 = resources.find((r) => r.id === 'project-2')
        const group3 = resources.find((r) => r.id === 'project-3')
        expect(group1?.members.map((m) => m.value).sort()).toEqual(['user-1', 'user-2'])
        expect(group2?.members.map((m) => m.value)).toEqual(['user-2'])
        expect(group3?.members.map((m) => m.value)).toEqual(['user-3'])
    })

    it('returns no groups (and issues no member/user queries) when there are no team projects', async () => {
        mockGetAllForUser.mockResolvedValue([])

        const result = await service.list({ platformId: 'platform-1' })

        expect(result.Resources).toHaveLength(0)
        expect(mockProjectMemberFind).not.toHaveBeenCalled()
        expect(mockUserFind).not.toHaveBeenCalled()
    })
})
