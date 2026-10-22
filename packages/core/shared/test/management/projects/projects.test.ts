import { describe, expect, it } from 'vitest'
import {
    ColorName,
    PiecesFilterType,
    PROJECT_COLOR_PALETTE,
    Project,
    ProjectIcon,
    ProjectPlan,
    ProjectType,
    ProjectWithLimits,
} from '../../../src/lib/management/project/project'
import {
    CreatePlatformProjectRequest,
    ListProjectRequestForPlatformQueryParams,
    UpdateProjectPlatformRequest,
} from '../../../src/lib/management/project/project-requests'
import {
    DefaultProjectRole,
} from '../../../src/lib/management/project/project-member'
import {
    ProjectMember,
} from '../../../src/lib/ee/project-members/project-member'

describe('PROJECT_COLOR_PALETTE and ColorName enum', () => {
    it('defines color mappings for all ColorName entries', () => {
        const colorNames = Object.values(ColorName)
        expect(colorNames).toHaveLength(12)
        for (const name of colorNames) {
            const entry = PROJECT_COLOR_PALETTE[name]
            expect(entry).toBeDefined()
            expect(entry.color).toMatch(/^#[0-9a-fA-F]{6}$/)
            expect(entry.textColor).toBe('#ffffff')
        }
    })
})

describe('Project and ProjectPlan models', () => {
    const validPlan = {
        id: '123456789012345678901',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        projectId: 'proj-1',
        locked: false,
        name: 'Free Plan',
        piecesFilterType: PiecesFilterType.ALLOWED,
        pieces: ['piece-slack', 'piece-github'],
    }

    it('parses valid ProjectPlan', () => {
        const parsed = ProjectPlan.parse(validPlan)
        expect(parsed.piecesFilterType).toBe(PiecesFilterType.ALLOWED)
        expect(parsed.pieces).toHaveLength(2)
        expect(parsed.locked).toBe(false)
    })

    const validProject = {
        id: '123456789012345678901',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        deleted: null,
        ownerId: 'user-1',
        displayName: 'Demo Project',
        platformId: '123456789012345678901',
        maxConcurrentJobs: null,
        type: ProjectType.TEAM,
        icon: { color: ColorName.BLUE },
        externalId: null,
        releasesEnabled: true,
        metadata: null,
        poolId: null,
        workerGroupId: null,
    }

    it('parses valid Project model', () => {
        const parsed = Project.parse(validProject)
        expect(parsed.displayName).toBe('Demo Project')
        expect(parsed.type).toBe(ProjectType.TEAM)
        expect(parsed.icon.color).toBe(ColorName.BLUE)
    })

    it('parses ProjectWithLimits including plan and analytics', () => {
        const projectWithLimits = {
            ...validProject,
            plan: validPlan,
            analytics: {
                totalUsers: 5,
                activeUsers: 3,
            },
        }
        const parsed = ProjectWithLimits.parse(projectWithLimits)
        expect(parsed.analytics.totalUsers).toBe(5)
        expect(parsed.plan.pieces).toContain('piece-slack')
    })
})

describe('CreatePlatformProjectRequest and SAFE_STRING_PATTERN defense', () => {
    it('parses valid platform project creation request', () => {
        const req = {
            displayName: 'Marketing-Workspace_2026',
            externalId: 'ext-mkt',
            metadata: { dept: 'marketing' },
            maxConcurrentJobs: 10,
            globalConnectionExternalIds: ['conn-1'],
            alertReceiverEmail: 'alerts@company.com',
        }
        const parsed = CreatePlatformProjectRequest.parse(req)
        expect(parsed.displayName).toBe('Marketing-Workspace_2026')
        expect(parsed.alertReceiverEmail).toBe('alerts@company.com')
    })

    it('enforces SAFE_STRING_PATTERN: rejects names containing "." or "/" (traversal guard)', () => {
        expect(() => CreatePlatformProjectRequest.parse({
            displayName: 'project.name',
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })).toThrow()

        expect(() => CreatePlatformProjectRequest.parse({
            displayName: 'path/traversal',
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })).toThrow()
    })
})

describe('UpdateProjectPlatformRequest schema', () => {
    it('parses update request with optional plan and icon', () => {
        const req = {
            releasesEnabled: false,
            displayName: 'Updated-Name',
            icon: { color: ColorName.GREEN },
            maxConcurrentJobs: 5,
            plan: {
                piecesFilterType: PiecesFilterType.NONE,
                pieces: [],
            },
        }
        const parsed = UpdateProjectPlatformRequest.parse(req)
        expect(parsed.releasesEnabled).toBe(false)
        expect(parsed.maxConcurrentJobs).toBe(5)
        expect(parsed.icon?.color).toBe(ColorName.GREEN)
    })
})

describe('ListProjectRequestForPlatformQueryParams schema', () => {
    it('parses query params and handles types array via OptionalArrayFromQuery', () => {
        const query = {
            displayName: 'Workspace',
            limit: '20',
            types: [ProjectType.TEAM, ProjectType.PERSONAL],
        }
        const parsed = ListProjectRequestForPlatformQueryParams.parse(query)
        expect(parsed.limit).toBe(20)
        expect(parsed.types).toEqual([ProjectType.TEAM, ProjectType.PERSONAL])
    })

    it('converts single scalar type into array via OptionalArrayFromQuery', () => {
        const query = {
            displayName: 'PersonalOnly',
            types: ProjectType.PERSONAL,
        }
        const parsed = ListProjectRequestForPlatformQueryParams.parse(query)
        expect(parsed.types).toEqual([ProjectType.PERSONAL])
    })
})

describe('ProjectMember schema and DefaultProjectRole', () => {
    it('verifies DefaultProjectRole enum values', () => {
        expect(DefaultProjectRole.ADMIN).toBe('Admin')
        expect(DefaultProjectRole.EDITOR).toBe('Editor')
        expect(DefaultProjectRole.VIEWER).toBe('Viewer')
    })

    it('parses ProjectMember model with valid ApIds', () => {
        const member = {
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            platformId: '123456789012345678901',
            userId: '123456789012345678902',
            projectId: 'proj-1',
            projectRoleId: '123456789012345678903',
        }
        const parsed = ProjectMember.parse(member)
        expect(parsed.platformId).toBe('123456789012345678901')
        expect(parsed.userId).toBe('123456789012345678902')
        expect(parsed.projectId).toBe('proj-1')
    })
})
