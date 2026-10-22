import { ApSystemProp, ProjectStateSnapshot } from '@inboxfm-connect/shared'
import { StatusCodes } from 'http-status-codes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { system } from '../../../../src/app/helper/system/system'
import { projectReplaceService } from '../../../../src/app/project/replace/project-replace.service'

const mocks = vi.hoisted(() => {
    const mockMcpFindOneBy = vi.fn()
    const mockMcpDelete = vi.fn()
    const mockMcpRotateToken = vi.fn()
    const mockDistributedLockRunExclusive = vi.fn(({ fn }: { fn: () => Promise<unknown> }) => fn())

    return {
        mockMcpFindOneBy,
        mockMcpDelete,
        mockMcpRotateToken,
        mockDistributedLockRunExclusive,
    }
})

vi.mock('../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({
        runExclusive: mocks.mockDistributedLockRunExclusive,
    }),
    redisConnections: {
        getRedisType: () => 'MEMORY',
    },
}))

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        find: vi.fn().mockResolvedValue([]),
        findOne: vi.fn().mockResolvedValue(null),
        findOneBy: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn((x) => x),
        save: vi.fn((x) => x),
    }),
}))

vi.mock('../../../../src/app/mcp/mcp-service', () => ({
    mcpServerRepository: () => ({
        findOneBy: mocks.mockMcpFindOneBy,
        delete: mocks.mockMcpDelete,
    }),
    mcpServerService: () => ({
        rotateToken: mocks.mockMcpRotateToken,
    }),
}))

vi.mock('../../../../src/app/tables/field/field.service', () => ({
    fieldService: {
        getAll: vi.fn().mockResolvedValue([]),
        getAllByTableIds: vi.fn().mockResolvedValue(new Map()),
    },
}))

describe('Project Replace — MCP Token Rotation & Apply Failure Paths (Issue #127)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        process.env.AP_PROJECT_REPLACE_SIGNING_SECRET = 'test-signing-secret-key-123456789'
    })

    const createTestSnapshot = (mcp: ProjectStateSnapshot['mcp'] = { externalId: 'default', disabledTools: [] }): ProjectStateSnapshot => ({
        schemaVersion: 1,
        sourceActivepiecesVersion: '0.120.0',
        exportedAt: '2026-01-01T00:00:00.000Z',
        sourceEnvironment: { projectId: 'proj-src' },
        tables: [],
        triggerBindings: [],
        scheduledTasks: [],
        mcp,
        requiredPieces: [],
        requiredConnections: [],
    })

    it('rejects cross-project replay or mismatched targetProjectId with 403 Forbidden', async () => {
        const service = projectReplaceService()
        const snapshot = createTestSnapshot()

        const plan = await service.createPlan({
            targetProjectId: 'proj-dest-alpha',
            targetPlatformId: 'plat-1',
            snapshot,
        })

        await expect(
            service.applyPlan({
                targetProjectId: 'proj-dest-beta', // Mismatched targetProjectId
                targetPlatformId: 'plat-1',
                request: {
                    plan,
                    snapshot,
                },
                snapshot,
            }),
        ).rejects.toMatchObject({
            statusCode: StatusCodes.FORBIDDEN,
            message: expect.stringContaining('Cross-project replacement rejected'),
        })
    })

    it('successfully rotates MCP token using default externalId and returns credentials', async () => {
        mocks.mockMcpFindOneBy.mockResolvedValue({
            id: 'mcp-1',
            projectId: 'proj-dest',
            token: 'old-token',
        })
        mocks.mockMcpRotateToken.mockResolvedValue({
            id: 'mcp-1',
            projectId: 'proj-dest',
            token: 'new-rotated-token-xyz',
        })

        vi.spyOn(system, 'get').mockReturnValue('https://app.inboxfm.com')

        const service = projectReplaceService()
        const snapshot = createTestSnapshot()

        const plan = await service.createPlan({
            targetProjectId: 'proj-dest',
            targetPlatformId: 'plat-1',
            snapshot,
        })

        const result = await service.applyPlan({
            targetProjectId: 'proj-dest',
            targetPlatformId: 'plat-1',
            request: {
                plan,
                snapshot,
                rotateMcpToken: true,
            },
            snapshot,
        })

        expect(result.failed).toHaveLength(0)
        expect(result.mcpCredentials).toEqual({
            token: 'new-rotated-token-xyz',
            serverUrl: 'https://app.inboxfm.com/mcp',
        })
        expect(mocks.mockMcpRotateToken).toHaveBeenCalledWith({ projectId: 'proj-dest' })
    })

    it('surfaces MCP rotation failure into failed[] with kind mcp_server and op ROTATE', async () => {
        mocks.mockMcpFindOneBy.mockResolvedValue({
            id: 'mcp-1',
            projectId: 'proj-dest',
            token: 'old-token',
        })
        mocks.mockMcpRotateToken.mockRejectedValue(new Error('KMS encryption key unavailable'))

        const service = projectReplaceService()
        const snapshot = createTestSnapshot()

        const plan = await service.createPlan({
            targetProjectId: 'proj-dest',
            targetPlatformId: 'plat-1',
            snapshot,
        })

        const result = await service.applyPlan({
            targetProjectId: 'proj-dest',
            targetPlatformId: 'plat-1',
            request: {
                plan,
                snapshot,
                rotateMcpToken: true,
            },
            snapshot,
        })

        expect(result.mcpCredentials).toBeNull()
        expect(result.failed).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'mcp_server',
                    externalId: 'default',
                    op: 'ROTATE',
                    error: expect.stringContaining('KMS encryption key unavailable'),
                }),
            ]),
        )
    })

    it('never rotates or resurrects MCP server when plan deletes mcp_server', async () => {
        mocks.mockMcpFindOneBy.mockResolvedValue({
            id: 'mcp-1',
            projectId: 'proj-dest',
            token: 'old-token',
        })

        const service = projectReplaceService()
        const deleteSnapshot = createTestSnapshot(null)

        const plan = await service.createPlan({
            targetProjectId: 'proj-dest',
            targetPlatformId: 'plat-1',
            snapshot: deleteSnapshot,
        })

        expect(plan.changes.deletes.some((d) => d.kind === 'mcp_server')).toBe(true)

        const result = await service.applyPlan({
            targetProjectId: 'proj-dest',
            targetPlatformId: 'plat-1',
            request: {
                plan,
                snapshot: deleteSnapshot,
                rotateMcpToken: true,
            },
            snapshot: deleteSnapshot,
        })

        expect(mocks.mockMcpRotateToken).not.toHaveBeenCalled()
        expect(result.mcpCredentials).toBeNull()
    })
})
