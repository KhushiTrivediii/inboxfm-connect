import crypto from 'crypto'
import { AIProviderName, apId } from '@inboxfm-connect/core-utils'
import {
    AgentToolType,
    AppConnectionScope,
    AppConnectionType,
    ConnectionMappingSchema,
    DefaultProjectRole,
    FieldType,
    McpAuthType,
    McpProtocol,
    PackageType,
    PieceType,
    PlatformRole,
    PrincipalType,
    ProjectReplaceArtifact,
    ProjectStateSnapshot,
    ProviderMappingSchema,
    TableAutomationStatus,
    TableAutomationTrigger,
    TriggerBindingStatus,
} from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { vi } from 'vitest'
import { agentService } from '../../../../src/app/agents/agent.service'
import { appConnectionService } from '../../../../src/app/app-connection/app-connection-service/app-connection-service'
import { mcpServerRepository, mcpServerService } from '../../../../src/app/mcp/mcp-service'
import { userInteractionWatcher } from '../../../../src/app/helper/user-interaction/user-interaction-watcher'
import { projectRepo } from '../../../../src/app/project/project-repo'
import { mockAndSaveAIProvider } from '../../../helpers/mocks'
import { createMemberContext, createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Project Replace API (CE)', () => {
    let ctx: TestContext

    beforeEach(async () => {
        ctx = await createTestContext(app!)
    })

    describe('Export Snapshot', () => {
        it('should export clean snapshot with schema-only and zero secrets', async () => {
            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                headers: { authorization: `Bearer ${ctx.token}` },
            })

            expect(response.statusCode).toBe(StatusCodes.OK)
            const snapshot: ProjectStateSnapshot = response.json()
            expect(snapshot.schemaVersion).toBe(1)
            expect(snapshot.sourceActivepiecesVersion).toBeDefined()
            expect(Array.isArray(snapshot.tables)).toBe(true)
            expect(Array.isArray(snapshot.triggerBindings)).toBe(true)
            expect(Array.isArray(snapshot.scheduledTasks)).toBe(true)
            expect(Array.isArray(snapshot.requiredPieces)).toBe(true)
            expect(Array.isArray(snapshot.requiredConnections)).toBe(true)
            expect(snapshot.mcp).toBeDefined()
        })
    })

    describe('Plan Generation (Dry-run)', () => {
        it('should generate deterministic signed plan with zero writes to destination', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: {
                    projectId: apId(),
                },
                tables: [
                    {
                        name: 'Inventory',
                        externalId: 'ext-inventory-1',
                        fields: [
                            { name: 'sku', type: FieldType.TEXT },
                            { name: 'quantity', type: FieldType.NUMBER },
                        ],
                    },
                ],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: {
                    disabledTools: ['dangerous-tool'],
                },
                requiredPieces: [],
                requiredConnections: [],
            }

            // Record initial state
            const initialExport = await app!.inject({
                method: 'GET',
                url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                headers: { authorization: `Bearer ${ctx.token}` },
            })
            const initialTablesCount = initialExport.json().tables.length

            // Plan call (dry-run)
            const planResponse = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })

            expect(planResponse.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planResponse.json()
            expect(artifact.plan.planId).toBeDefined()
            expect(artifact.plan.signature).toBeDefined()
            expect(artifact.plan.changes.creates.some((c) => c.kind === 'table' && c.name === 'Inventory')).toBe(true)
            expect(artifact.plan.changes.creates.some((c) => c.kind === 'mcp_server')).toBe(true)

            // Verify strictly ZERO writes occurred to destination
            const postExport = await app!.inject({
                method: 'GET',
                url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                headers: { authorization: `Bearer ${ctx.token}` },
            })
            expect(postExport.json().tables.length).toBe(initialTablesCount)
        })

        it('should report preflight errors when referenced connections are missing', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: {
                    projectId: apId(),
                },
                tables: [],
                triggerBindings: [
                    {
                        externalId: 'ext-tb-1',
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '1.0.0',
                        triggerName: 'new_message',
                        promptTemplate: 'Handle {{message}}',
                        connectionExternalId: 'missing-conn-123',
                        settings: {},
                        propertySettings: null,
                        status: 'ENABLED',
                    },
                ],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [
                    {
                        externalId: 'missing-conn-123',
                        pieceName: '@inboxfm-connect/piece-slack',
                    },
                ],
            }

            const response = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })

            // Preflight error returns BAD_REQUEST (400) with artifact containing preflight error details
            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact: ProjectReplaceArtifact = response.json()
            expect(artifact.plan.preflight.passed).toBe(false)
            expect(artifact.plan.preflight.errors.length).toBeGreaterThan(0)
            expect(artifact.plan.preflight.errors.some((e) => e.message.includes('missing-conn-123'))).toBe(true)
        })
    })

    describe('Apply Plan', () => {
        it('should reject tampered plan signature with 400 Bad Request', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: {
                    projectId: apId(),
                },
                tables: [{ name: 'Orders', externalId: 'ext-orders', fields: [] }],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Tamper signature
            const tamperedPlan = {
                ...artifact.plan,
                signature: 'a'.repeat(64), // invalid fake signature
            }

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: tamperedPlan,
                    snapshot: artifact.snapshot,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('should detect destination drift and fail with 409 Conflict', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: {
                    projectId: apId(),
                },
                tables: [{ name: 'Products', externalId: 'ext-products', fields: [] }],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            // Create plan
            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Induce drift on destination (apply another plan with a different table)
            const driftSnapshot: ProjectStateSnapshot = {
                ...sourceSnapshot,
                tables: [{ name: 'DriftTable', externalId: 'ext-drift', fields: [] }],
            }
            const driftPlanRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: driftSnapshot,
            })
            await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: driftPlanRes.json().plan,
                    snapshot: driftPlanRes.json().snapshot,
                },
            })

            // Now apply the original plan, which was generated against previous destination state
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('should successfully apply valid plan and converge state', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: {
                    projectId: apId(),
                },
                tables: [
                    {
                        name: 'ConvergedTable',
                        externalId: 'ext-converged-table',
                        fields: [
                            { name: 'name', type: FieldType.TEXT },
                            { name: 'score', type: FieldType.NUMBER },
                        ],
                    },
                ],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: {
                    disabledTools: ['tool_alpha'],
                },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const result = applyRes.json()
            expect(result.applied.tablesCreated).toBe(1)
            expect(result.applied.mcpCreated).toBe(1)
            expect(result.failed).toHaveLength(0)

            // Verify state in destination
            const verifyExport = await app!.inject({
                method: 'GET',
                url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                headers: { authorization: `Bearer ${ctx.token}` },
            })
            const verifySnapshot: ProjectStateSnapshot = verifyExport.json()
            const createdTable = verifySnapshot.tables.find((t) => t.name === 'ConvergedTable')
            expect(createdTable).toBeDefined()
            expect(createdTable?.fields?.map((f) => f.name).sort()).toEqual(['name', 'score'])
            expect(verifySnapshot.mcp?.disabledTools).toContain('tool_alpha')
        })

        it('should reject apply when snapshot is swapped with a valid plan signature', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [{ name: 'TableA', externalId: 'ext-a', fields: [] }],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Swap snapshot with a different one
            const swappedSnapshot: ProjectStateSnapshot = {
                ...sourceSnapshot,
                tables: [{ name: 'TableB', externalId: 'ext-b', fields: [] }],
            }

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: swappedSnapshot,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(applyRes.json().message).toContain('Submitted snapshot checksum does not match plan checksum')
        })

        it('should reject cross-project plan replay against a different project', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [{ name: 'ProjectATable', externalId: 'ext-proj-a', fields: [] }],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            // Plan for Project 1 (ctx.project.id)
            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Try to replay plan against another project
            const otherCtx = await createTestContext(app!)
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${otherCtx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${otherCtx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(applyRes.json().message).toContain('Cross-project replacement rejected')
        })

        it('should report VERSION_SKEW preflight error for invalid semver string instead of throwing 500', async () => {
            const invalidSemverSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: 'dev-unknown-version',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: invalidSemverSnapshot,
            })

            // Should be 400 Bad Request with preflight error, NOT 500 internal server error
            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(false)
            expect(artifact.plan.preflight.errors.some((e) => e.kind === 'VERSION_SKEW')).toBe(true)
        })

        it('should detect drift when task timezone or trigger binding settings change', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [
                    {
                        externalId: 'st-tz-test',
                        prompt: 'Daily digest',
                        cronExpression: '0 9 * * *',
                        timezone: 'UTC',
                        status: 'ENABLED',
                    },
                ],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            // Apply initially
            const planRes1 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: planRes1.json().plan,
                    snapshot: planRes1.json().snapshot,
                },
            })

            // Generate plan for state with timezone UTC
            const planRes2 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            const artifact2: ProjectReplaceArtifact = planRes2.json()

            // Update timezone directly on destination to America/New_York (induces drift)
            const { ScheduledTaskEntity } = await import('../../../../src/app/execution/scheduled-task/scheduled-task-entity')
            const { repoFactory } = await import('../../../../src/app/core/db/repo-factory')
            await repoFactory(ScheduledTaskEntity)().update({ projectId: ctx.project.id }, { timezone: 'America/New_York' })

            // Now apply artifact2 -> must fail with 409 CONFLICT due to timezone drift
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact2.plan,
                    snapshot: artifact2.snapshot,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('should reject preflight when custom piece archive checksum is missing or mismatched', async () => {
            const crypto = await import('crypto')
            const dummyArchive = Buffer.from('test-package-payload-content').toString('base64')
            const correctChecksum = crypto.createHash('sha256').update(Buffer.from('test-package-payload-content')).digest('hex')

            // Test 1: Missing archiveChecksum
            const snapshotWithoutChecksum: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                customPieces: [{
                    name: '@custom/missing-checksum',
                    version: '1.0.0',
                    pieceType: 'CUSTOM',
                    packageType: 'ARCHIVE',
                    archiveFileBase64: dummyArchive,
                }],
                requiredConnections: [],
            }

            const planRes1 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshotWithoutChecksum,
            })
            expect(planRes1.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact1 = planRes1.json()
            expect(artifact1.plan.preflight.passed).toBe(false)
            expect(artifact1.plan.preflight.errors.some((e: any) => e.kind === 'CHECKSUM_MISMATCH')).toBe(true)

            // Test 2: Mismatched archiveChecksum
            const snapshotWithWrongChecksum: ProjectStateSnapshot = {
                ...snapshotWithoutChecksum,
                customPieces: [{
                    name: '@custom/bad-checksum',
                    version: '1.0.0',
                    pieceType: 'CUSTOM',
                    packageType: 'ARCHIVE',
                    archiveFileBase64: dummyArchive,
                    archiveChecksum: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
                }],
            }

            const planRes2 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshotWithWrongChecksum,
            })
            expect(planRes2.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact2 = planRes2.json()
            expect(artifact2.plan.preflight.passed).toBe(false)
            expect(artifact2.plan.preflight.errors.some((e: any) => e.kind === 'CHECKSUM_MISMATCH')).toBe(true)

            // Test 3: Valid archiveChecksum produces valid plan with deployable piece
            const snapshotWithValidChecksum: ProjectStateSnapshot = {
                ...snapshotWithoutChecksum,
                customPieces: [{
                    name: '@custom/valid-piece',
                    version: '1.0.0',
                    pieceType: 'CUSTOM',
                    packageType: 'ARCHIVE',
                    archiveFileBase64: dummyArchive,
                    archiveChecksum: correctChecksum,
                }],
            }

            const planRes3 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshotWithValidChecksum,
            })
            expect(planRes3.statusCode).toBe(StatusCodes.OK)
            const artifact3 = planRes3.json()
            expect(artifact3.plan.preflight.passed).toBe(true)
            expect(artifact3.plan.preflight.customIntegrations.deployable.length).toBe(1)
            expect(artifact3.plan.changes.creates.some((c: any) => c.kind === 'custom_piece' && c.name === '@custom/valid-piece@1.0.0')).toBe(true)
        })

        it('should block dependent trigger bindings when dependent custom piece install fails or is missing', async () => {
            // Snapshot with missing custom piece AND a trigger binding referencing it
            const snapshotWithDependent: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [{
                    externalId: 'tb-custom-dep',
                    pieceName: '@custom/missing-dep',
                    pieceVersion: '1.0.0',
                    triggerName: 'test_trigger',
                    promptTemplate: 'run when event fires',
                    settings: {},
                    status: 'ENABLED',
                }],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [{
                    name: '@custom/missing-dep',
                    version: '1.0.0',
                    pieceType: 'CUSTOM',
                }],
                customPieces: [{
                    name: '@custom/missing-dep',
                    version: '1.0.0',
                    pieceType: 'CUSTOM',
                }],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshotWithDependent,
            })
            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(false)

            // When applying with force: true, trigger binding creation MUST be blocked
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    force: true,
                },
            })

            // Multi-status or response contains failure for the trigger binding
            expect([StatusCodes.OK, StatusCodes.MULTI_STATUS]).toContain(applyRes.statusCode)
            const result = applyRes.json()
            expect(result.applied.triggerBindingsCreated).toBe(0)
            const tbFailure = result.failed.find((f: any) => f.kind === 'trigger_binding')
            expect(tbFailure).toBeDefined()
            expect(tbFailure.error).toContain('Activation blocked: dependent custom integration')
        })

        it('should perform zero mutations when inspectOnly is true', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [{ name: 'InspectOnlyTable', externalId: 'ext-inspect', fields: [] }],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                customPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            const artifact = planRes.json()

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    inspectOnly: true,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const result = applyRes.json()
            expect(result.applied.tablesCreated).toBe(0)

            // Verify table was NOT actually created in destination
            const { TableEntity } = await import('../../../../src/app/tables/table/table.entity')
            const { repoFactory } = await import('../../../../src/app/core/db/repo-factory')
            const created = await repoFactory(TableEntity)().findOneBy({ projectId: ctx.project.id, externalId: 'ext-inspect' })
            expect(created).toBeNull()
        })

        it('should check compatibility for already installed custom pieces and reject with INCOMPATIBLE_INTEGRATION', async () => {
            const { pieceMetadataService } = await import('../../../../src/app/pieces/metadata/piece-metadata-service')
            const { createMockPieceMetadata } = await import('../../../helpers/mocks')
            await pieceMetadataService(app!.log).create({
                pieceMetadata: createMockPieceMetadata({
                    name: '@custom/installed-incompatible',
                    version: '1.0.0',
                    minimumSupportedRelease: '99.0.0',
                }),
                platformId: ctx.platform.id,
                packageType: PackageType.REGISTRY,
                pieceType: PieceType.CUSTOM,
            })

            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                customPieces: [{
                    name: '@custom/installed-incompatible',
                    version: '1.0.0',
                    pieceType: 'CUSTOM',
                    minimumSupportedRelease: '99.0.0',
                }],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshot,
            })

            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(false)
            expect(artifact.plan.preflight.errors.some((e: any) => e.kind === 'INCOMPATIBLE_INTEGRATION')).toBe(true)
            // Crucial: Incompatible piece must NOT be counted as unchanged!
            expect(artifact.plan.changes.unchanged.some((u: any) => u.externalId.includes('@custom/installed-incompatible'))).toBe(false)
        })

        it('should allow inspection via POST /inspect with READ_PROJECT permission and perform zero mutations', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [{ name: 'InspectEndpointTable', externalId: 'ext-inspect-ep', fields: [] }],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                customPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            const artifact = planRes.json()

            // Call dedicated /inspect endpoint
            const inspectRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/inspect`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                },
            })

            expect(inspectRes.statusCode).toBe(StatusCodes.OK)
            const result = inspectRes.json()
            expect(result.applied.tablesCreated).toBe(0)

            // Verify table was NOT actually created in destination
            const { TableEntity } = await import('../../../../src/app/tables/table/table.entity')
            const { repoFactory } = await import('../../../../src/app/core/db/repo-factory')
            const created = await repoFactory(TableEntity)().findOneBy({ projectId: ctx.project.id, externalId: 'ext-inspect-ep' })
            expect(created).toBeNull()
        })

        it('should allow /inspect on a plan with failing preflight without throwing 400', async () => {
            const failingSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [{
                    name: '@custom/missing-piece',
                    version: '1.0.0',
                    packageType: PackageType.ARCHIVE,
                    pieceType: PieceType.CUSTOM,
                }],
                customPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: failingSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(false)

            // POST /inspect on a plan with failing preflight MUST succeed with 200 and zero mutations
            const inspectRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/inspect`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: failingSnapshot,
                },
            })

            expect(inspectRes.statusCode).toBe(StatusCodes.OK)
            const result = inspectRes.json()
            expect(result.applied.customPiecesInstalled).toBe(0)
            expect(result.failed.length).toBe(0)
        })

        it('should reject non-platform-admin applying plan with deployCustomIntegrations', async () => {
            const operatorCtx = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })
            await projectRepo().update({ id: ctx.project.id, platformId: ctx.platform.id }, { ownerId: operatorCtx.user.id })

            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                customPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshot,
            })
            const artifact = planRes.json()

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${operatorCtx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot,
                    deployCustomIntegrations: true,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(applyRes.json().code).toBe('PERMISSION_DENIED')
        })

        it('should block custom piece installation when blocked by piece filtering policy', async () => {
            const archiveContent = Buffer.from('test archive payload')
            const checksum = crypto.createHash('sha256').update(archiveContent).digest('hex')

            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [{
                    name: '@custom/blocked-piece',
                    version: '1.0.0',
                    packageType: PackageType.ARCHIVE,
                    pieceType: PieceType.CUSTOM,
                    archiveChecksum: checksum,
                    archiveFileBase64: archiveContent.toString('base64'),
                }],
                customPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact = planRes.json()

            const { pieceFilteringHooks } = await import('../../../../src/app/pieces/metadata/utils/piece-filtering-hooks')
            pieceFilteringHooks.set((_log) => ({
                async filter(p) { return p.pieces },
                async isFiltered() { return true },
            }))

            try {
                const applyRes = await app!.inject({
                    method: 'POST',
                    url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                    headers: { authorization: `Bearer ${ctx.token}` },
                    body: {
                        plan: artifact.plan,
                        snapshot,
                        deployCustomIntegrations: true,
                    },
                })

                expect(applyRes.statusCode).toBe(StatusCodes.MULTI_STATUS)
                const result = applyRes.json()
                expect(result.applied.customPiecesInstalled).toBe(0)
                expect(result.failed.some((f: any) => f.kind === 'custom_piece' && f.error.includes('blocked by platform policy'))).toBe(true)
            }
            finally {
                pieceFilteringHooks.set((_log) => ({
                    async filter(p) { return p.pieces },
                    async isFiltered() { return false },
                }))
            }
        })
    })

    describe('Connection Mapping, Bootstrap & Security (Issue #53)', () => {
        it('should report MISSING_CONNECTION with actionable preflight details and report', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [
                    {
                        externalId: 'tb-slack-unmatched',
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '1.0.0',
                        triggerName: 'new_message',
                        promptTemplate: 'Handle message',
                        connectionExternalId: 'slack-unmatched-source',
                        settings: {},
                        propertySettings: null,
                        status: 'ENABLED',
                    },
                ],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [
                    {
                        externalId: 'slack-unmatched-source',
                        pieceName: '@inboxfm-connect/piece-slack',
                    },
                ],
            }

            const res = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })

            expect(res.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact: ProjectReplaceArtifact = res.json()
            expect(artifact.plan.preflight.passed).toBe(false)
            expect(artifact.plan.preflight.errors.some((e) => e.kind === 'MISSING_CONNECTION')).toBe(true)

            const connPreflight = artifact.plan.preflight.connections
            expect(connPreflight).toBeDefined()
            expect(connPreflight?.required).toHaveLength(1)
            expect(connPreflight?.required[0].externalId).toBe('slack-unmatched-source')
            expect(connPreflight?.missing).toHaveLength(1)
            expect(connPreflight?.missing[0].externalId).toBe('slack-unmatched-source')
            expect(connPreflight?.missing[0].actionableHelp).toBeDefined()
            expect(connPreflight?.matched).toHaveLength(0)
            expect(connPreflight?.mapped).toHaveLength(0)
        })

        it('should report INCOMPATIBLE_CONNECTION in preflight when piece mismatch occurs', async () => {
            // Create a Square connection on destination
            await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'conn-incompatible-check',
                displayName: 'Square Connection',
                pieceName: '@inboxfm-connect/piece-square',
                pieceVersion: '1.0.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'square-key-123',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [
                    {
                        externalId: 'conn-incompatible-check',
                        pieceName: '@inboxfm-connect/piece-slack', // Source expects Slack, destination has Square
                    },
                ],
            }

            const res = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })

            expect(res.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact: ProjectReplaceArtifact = res.json()
            expect(artifact.plan.preflight.passed).toBe(false)
            expect(artifact.plan.preflight.errors.some((e) => e.kind === 'INCOMPATIBLE_CONNECTION')).toBe(true)
        })

        it('should remap source connection to existing destination connection', async () => {
            // Create target connection on destination
            await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'dest-slack-existing',
                displayName: 'Production Slack',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '1.0.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'xoxb-prod-token',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [
                    {
                        externalId: 'tb-remapped-1',
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '1.0.0',
                        triggerName: 'new_message',
                        promptTemplate: 'Handle Slack message',
                        connectionExternalId: 'staging-slack-conn',
                        settings: {},
                        propertySettings: null,
                        status: 'ENABLED',
                    },
                ],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [
                    {
                        externalId: 'staging-slack-conn',
                        pieceName: '@inboxfm-connect/piece-slack',
                    },
                ],
            }

            const connectionMappings: ConnectionMappingSchema[] = [
                {
                    sourceExternalId: 'staging-slack-conn',
                    destExternalId: 'dest-slack-existing',
                },
            ]

            // 1. Plan with connection mapping
            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    snapshot: sourceSnapshot,
                    connectionMappings,
                },
            })

            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(true)

            const connPreflight = artifact.plan.preflight.connections
            expect(connPreflight?.matched).toHaveLength(1)
            expect(connPreflight?.matched[0].destExternalId).toBe('dest-slack-existing')
            expect(connPreflight?.mapped).toHaveLength(1)
            expect(connPreflight?.mapped[0].mappingType).toBe('REMAP')

            // 2. Apply with connection mapping
            vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockResolvedValue({ output: [] } as never)
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    connectionMappings,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const applyResult = applyRes.json()
            expect(applyResult.applied.triggerBindingsCreated).toBe(1)
            expect(applyResult.applied.connectionsUnchanged).toBe(1)
            expect(applyResult.failed).toHaveLength(0)

            // Verify trigger binding was bound to dest-slack-existing
            const exportRes = await app!.inject({
                method: 'GET',
                url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                headers: { authorization: `Bearer ${ctx.token}` },
            })
            const exp = exportRes.json()
            const tb = exp.triggerBindings.find((b: { pieceName: string, triggerName: string }) => b.pieceName === '@inboxfm-connect/piece-slack' && b.triggerName === 'new_message')
            expect(tb).toBeDefined()
            expect(tb.connectionExternalId).toBe('dest-slack-existing')
        })

        it('should bootstrap new destination connection with credentials and bind to triggers', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [
                    {
                        externalId: 'tb-bootstrap-1',
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '1.0.0',
                        triggerName: 'new_message',
                        promptTemplate: 'Handle message',
                        connectionExternalId: 'source-slack-to-bootstrap',
                        settings: {},
                        propertySettings: null,
                        status: 'ENABLED',
                    },
                ],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [
                    {
                        externalId: 'source-slack-to-bootstrap',
                        pieceName: '@inboxfm-connect/piece-slack',
                    },
                ],
            }

            const connectionMappings: ConnectionMappingSchema[] = [
                {
                    sourceExternalId: 'source-slack-to-bootstrap',
                    destExternalId: 'dest-bootstrapped-slack',
                    pieceName: '@inboxfm-connect/piece-slack',
                    type: AppConnectionType.SECRET_TEXT,
                    value: {
                        secret_text: 'xoxb-ci-bootstrapped-token-456',
                    },
                    displayName: 'CI Bootstrapped Slack',
                },
            ]

            // 1. Plan with bootstrap mapping
            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    snapshot: sourceSnapshot,
                    connectionMappings,
                },
            })

            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(true)

            const connPreflight = artifact.plan.preflight.connections
            expect(connPreflight?.mapped).toHaveLength(1)
            expect(connPreflight?.mapped[0].mappingType).toBe('BOOTSTRAP')
            expect(artifact.plan.changes.creates.some((c: any) => c.kind === 'connection' && c.externalId === 'dest-bootstrapped-slack')).toBe(true)

            // 2. Apply with bootstrap credentials
            vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockResolvedValue({ output: [] } as never)
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    connectionMappings,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const applyResult = applyRes.json()
            expect(applyResult.applied.connectionsCreated).toBe(1)
            expect(applyResult.applied.triggerBindingsCreated).toBe(1)
            expect(applyResult.failed).toHaveLength(0)

            // 3. Verify convergence / idempotency on re-run
            const rerunPlanRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    snapshot: sourceSnapshot,
                    connectionMappings,
                },
            })
            expect(rerunPlanRes.statusCode).toBe(StatusCodes.OK)

            const rerunApplyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: rerunPlanRes.json().plan,
                    snapshot: rerunPlanRes.json().snapshot,
                    connectionMappings,
                },
            })

            expect(rerunApplyRes.statusCode).toBe(StatusCodes.OK)
            const rerunResult = rerunApplyRes.json()
            expect(rerunResult.applied.connectionsCreated).toBe(0)
            expect(rerunResult.applied.connectionsUpdated).toBe(1)
            expect(rerunResult.applied.triggerBindingsUnchanged).toBe(1)
        })

        it('should safely gate trigger bindings when required connection fails to resolve', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [
                    {
                        externalId: 'tb-gated-1',
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '1.0.0',
                        triggerName: 'new_message',
                        promptTemplate: 'Handle message',
                        connectionExternalId: 'nonexistent-conn-1',
                        settings: {},
                        propertySettings: null,
                        status: 'ENABLED',
                    },
                ],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [
                    {
                        externalId: 'nonexistent-conn-1',
                        pieceName: '@inboxfm-connect/piece-slack',
                    },
                ],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Forced apply with unresolvable connection
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    force: true,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.MULTI_STATUS)
            const applyResult = applyRes.json()
            expect(applyResult.failed.some((f: { kind: string, error: string }) => f.kind === 'trigger_binding' && f.error.includes('Activation blocked'))).toBe(true)
            expect(applyResult.applied.triggerBindingsCreated).toBe(0)
        })

        it('should reject apply when connection mappings have been tampered or substituted (Finding 1)', async () => {
            await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'dest-slack-approved',
                displayName: 'Approved Slack',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '1.0.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'token-1',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'dest-slack-substituted',
                displayName: 'Substituted Slack',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '1.0.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'token-2',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [{
                    externalId: 'source-slack-audit',
                    pieceName: '@inboxfm-connect/piece-slack',
                }],
            }

            const approvedMappings: ConnectionMappingSchema[] = [{
                sourceExternalId: 'source-slack-audit',
                destExternalId: 'dest-slack-approved',
            }]

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    snapshot: sourceSnapshot,
                    connectionMappings: approvedMappings,
                },
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Attempt apply with swapped mapping
            const swappedMappings: ConnectionMappingSchema[] = [{
                sourceExternalId: 'source-slack-audit',
                destExternalId: 'dest-slack-substituted',
            }]

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    connectionMappings: swappedMappings,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(applyRes.json().message).toContain('Connection mappings supplied at apply time do not match the signed plan')
        })

        it('should revalidate direct connection matches for piece compatibility during apply and gate bindings even under --force (Finding 2)', async () => {
            // Destination connection has Square piece
            await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'conn-direct-wrong-piece',
                displayName: 'Square Conn',
                pieceName: '@inboxfm-connect/piece-square',
                pieceVersion: '1.0.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'square-key',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [{
                    externalId: 'tb-slack-with-square-conn',
                    pieceName: '@inboxfm-connect/piece-slack',
                    pieceVersion: '1.0.0',
                    triggerName: 'new_message',
                    promptTemplate: 'handle',
                    connectionExternalId: 'conn-direct-wrong-piece',
                    settings: {},
                    status: 'ENABLED',
                }],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [{
                    externalId: 'conn-direct-wrong-piece',
                    pieceName: '@inboxfm-connect/piece-slack', // Source requires Slack!
                }],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Applying with force: true MUST still revalidate piece compatibility at apply time!
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    force: true,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.MULTI_STATUS)
            const result = applyRes.json()
            expect(result.applied.triggerBindingsCreated).toBe(0)

            const connFailure = result.failed.find((f: any) => f.kind === 'connection' && f.externalId === 'conn-direct-wrong-piece')
            expect(connFailure).toBeDefined()
            expect(connFailure.error).toContain('Incompatible connection')

            const tbFailure = result.failed.find((f: any) => f.kind === 'trigger_binding' && f.externalId === 'tb-slack-with-square-conn')
            expect(tbFailure).toBeDefined()
            expect(tbFailure.error).toContain('Activation blocked')
        })

        it('should strictly scope connection lookups to target project and reject cross-project connection access (Finding 3)', async () => {
            // Create a completely separate project on the same platform
            const { createMockProject } = await import('../../../helpers/mocks')
            const { databaseConnection } = await import('../../../../src/app/database/database-connection')
            const otherProject = createMockProject({
                ownerId: ctx.user.id,
                platformId: ctx.platform.id,
            })
            await databaseConnection().getRepository('project').save(otherProject)

            await appConnectionService(app!.log).upsert({
                projectIds: [otherProject.id], // Belongs to other project only!
                platformId: ctx.platform.id,
                externalId: 'conn-in-other-project',
                displayName: 'Other Project Slack',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '1.0.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'other-token',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [{
                    externalId: 'conn-in-other-project',
                    pieceName: '@inboxfm-connect/piece-slack',
                }],
            }

            // Plan against ctx.project.id MUST report MISSING_CONNECTION because conn-in-other-project is not in ctx.project.id!
            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })

            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.preflight.errors.some((e) => e.kind === 'MISSING_CONNECTION')).toBe(true)
            expect(artifact.plan.preflight.connections?.missing.some((m) => m.externalId === 'conn-in-other-project')).toBe(true)
        })

        it('should clear table status and trigger columns when source snapshot explicitly sets null (Finding 4)', async () => {
            const { TableEntity } = await import('../../../../src/app/tables/table/table.entity')
            const { repoFactory } = await import('../../../../src/app/core/db/repo-factory')
            const tableRepo = repoFactory(TableEntity)

            // Seed destination table with ENABLED status and ON_NEW_RECORD trigger
            const seededTable = await tableRepo().save({
                id: apId(),
                projectId: ctx.project.id,
                name: 'TableWithNullSync',
                externalId: 'ext-table-null-sync',
                status: TableAutomationStatus.ENABLED,
                trigger: TableAutomationTrigger.ON_NEW_RECORD,
            })
            expect(seededTable.status).toBe(TableAutomationStatus.ENABLED)
            expect(seededTable.trigger).toBe(TableAutomationTrigger.ON_NEW_RECORD)

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [{
                    name: 'TableWithNullSync',
                    externalId: 'ext-table-null-sync',
                    status: null,
                    trigger: null,
                    fields: [],
                }],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.changes.updates.some((u: any) => u.kind === 'table' && u.externalId === 'ext-table-null-sync')).toBe(true)

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                },
            })
            expect(applyRes.statusCode).toBe(StatusCodes.OK)

            // Re-fetch from DB and assert status and trigger were cleared to NULL
            const updatedTable = await tableRepo().findOneBy({ projectId: ctx.project.id, externalId: 'ext-table-null-sync' })
            expect(updatedTable).toBeDefined()
            expect(updatedTable?.status).toBeNull()
            expect(updatedTable?.trigger).toBeNull()
        })

        it('should reject tampered artifact signatures when using /inspect endpoint (Finding 5)', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Tamper with the plan signature
            const tamperedPlan = {
                ...artifact.plan,
                signature: 'deadbeef' + artifact.plan.signature.slice(8),
            }

            const inspectRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/inspect`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: tamperedPlan,
                    snapshot: artifact.snapshot,
                },
            })

            expect(inspectRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(inspectRes.json().message).toContain('Plan signature verification failed')
        })

        it('should allow /inspect on a plan with failing preflight without throwing 400', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [{
                    externalId: 'conn-nonexistent',
                    pieceName: '@inboxfm-connect/piece-slack',
                }],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(false)

            const inspectRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/inspect`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                },
            })

            expect(inspectRes.statusCode).toBe(StatusCodes.OK)
            const inspectResult = inspectRes.json()
            expect(inspectResult.applied.tablesCreated).toBe(0)
            expect(inspectResult.failed.length).toBe(0)
        })

        it('should reject non-platform-admin applying plan with deployCustomIntegrations', async () => {
            const { createMockProjectMember, createMockProjectRole, mockBasicUser } = await import('../../../helpers/mocks')
            const { Permission, PlatformRole, DefaultProjectRole, RoleType, PrincipalType } = await import('@inboxfm-connect/shared')
            const { databaseConnection } = await import('../../../../src/app/database/database-connection')

            // Create a non-admin member on ctx.platform.id
            const { mockUser: nonAdminUser } = await mockBasicUser({
                user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER, externalId: 'ext-non-admin' },
            })
            await databaseConnection().getRepository('user').save(nonAdminUser)

            const role = createMockProjectRole({
                platformId: ctx.platform.id,
                type: RoleType.DEFAULT,
                name: DefaultProjectRole.ADMIN,
                permissions: [Permission.WRITE_PROJECT, Permission.READ_PROJECT],
            })
            await databaseConnection().getRepository('project_role').save(role)

            const membership = createMockProjectMember({
                platformId: ctx.platform.id,
                projectId: ctx.project.id,
                userId: nonAdminUser.id,
                projectRoleId: role.id,
            })
            await databaseConnection().getRepository('project_member').save(membership)

            const { generateMockToken } = await import('../../../helpers/auth')
            const nonAdminToken = await generateMockToken({
                id: nonAdminUser.id,
                type: PrincipalType.USER,
                projectId: ctx.project.id,
                platform: { id: ctx.platform.id },
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            const artifact: ProjectReplaceArtifact = planRes.json()

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${nonAdminToken}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    deployCustomIntegrations: true,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('should mark trigger binding as UPDATE and reassign connectionId when trigger binding connection is remapped', async () => {
            const { triggerBindingService } = await import('../../../../src/app/execution/trigger-binding/trigger-binding.service')
            const { TriggerBindingEntity } = await import('../../../../src/app/execution/trigger-binding/trigger-binding-entity')
            const { repoFactory } = await import('../../../../src/app/core/db/repo-factory')
            const tbRepo = repoFactory(TriggerBindingEntity)

            // 1. Create two destination connections (old and new)
            const connA = await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'conn-dest-a',
                displayName: 'Dest Slack Conn A',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '1.0.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'token-a',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            const connB = await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'conn-dest-b',
                displayName: 'Dest Slack Conn B',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '1.0.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'token-b',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            // 2. Create existing trigger binding bound to connA
            const existingTb = await triggerBindingService.create({
                projectId: ctx.project.id,
                platformId: ctx.platform.id,
                request: {
                    pieceName: '@inboxfm-connect/piece-slack',
                    pieceVersion: '1.0.0',
                    triggerName: 'new_message',
                    promptTemplate: 'handle message',
                    connectionId: connA.id,
                    settings: { channel: 'general' },
                    status: TriggerBindingStatus.ENABLED,
                },
            })
            expect(existingTb.connectionId).toBe(connA.id)

            // 3. Source snapshot has identical settings and promptTemplate, but references 'conn-source-slack'
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [{
                    externalId: existingTb.id,
                    pieceName: '@inboxfm-connect/piece-slack',
                    pieceVersion: '1.0.0',
                    triggerName: 'new_message',
                    promptTemplate: 'handle message',
                    connectionExternalId: 'conn-source-slack',
                    settings: { channel: 'general' },
                    status: TriggerBindingStatus.ENABLED,
                }],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [{
                    externalId: 'conn-source-slack',
                    pieceName: '@inboxfm-connect/piece-slack',
                }],
            }

            // Remap conn-source-slack to conn-dest-b
            const connectionMappings: ConnectionMappingSchema[] = [{
                sourceExternalId: 'conn-source-slack',
                destExternalId: 'conn-dest-b',
            }]

            // 4. Plan should detect that the trigger binding needs UPDATE because connection changed
            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    snapshot: sourceSnapshot,
                    connectionMappings,
                },
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()

            const tbUpdate = artifact.plan.changes.updates.find((u) => u.kind === 'trigger_binding' && u.externalId === existingTb.id)
            expect(tbUpdate).toBeDefined()
            expect(artifact.plan.changes.unchanged.some((u) => u.kind === 'trigger_binding' && u.externalId === existingTb.id)).toBe(false)

            // 5. Apply the plan
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    connectionMappings,
                },
            })
            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const result = applyRes.json()
            expect(result.applied.triggerBindingsUpdated).toBe(1)

            // 6. Verify destination trigger binding now has connB.id
            const updatedTb = await tbRepo().findOneBy({ id: existingTb.id })
            expect(updatedTb).toBeDefined()
            expect(updatedTb?.connectionId).toBe(connB.id)
        })
    })

    describe('Agent Definition and Tool Binding Mirroring (Issue #52)', () => {
        it('should export standalone agent definitions and sanitize tool secrets', async () => {
            const conn = await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'agent-conn-src',
                displayName: 'Slack for Agent',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '0.1.0',
                type: AppConnectionType.SECRET_TEXT,
                value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'super-secret' },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            await agentService.create({
                projectId: ctx.project.id,
                platformId: ctx.platform.id,
                externalId: 'agent-export-test',
                displayName: 'Customer Support Bot',
                description: 'Handles support requests',
                prompt: 'You are a support bot.',
                maxSteps: 15,
                model: {
                    provider: 'openai',
                    model: 'gpt-4o',
                },
                tools: [
                    {
                        type: AgentToolType.PIECE,
                        toolName: 'send_slack_message',
                        pieceMetadata: {
                            pieceName: '@inboxfm-connect/piece-slack',
                            pieceVersion: '0.1.0',
                            actionName: 'send_message',
                            predefinedInput: {
                                auth: conn.id,
                                fields: {},
                            },
                        },
                    },
                    {
                        type: AgentToolType.MCP,
                        toolName: 'knowledge_mcp',
                        serverUrl: 'https://mcp.example.com',
                        protocol: McpProtocol.SSE,
                        auth: {
                            type: McpAuthType.ACCESS_TOKEN,
                            accessToken: 'live-bearer-secret-token',
                        },
                    },
                ],
                structuredOutput: null,
                status: 'ENABLED',
            })

            const exportRes = await app!.inject({
                method: 'GET',
                url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                headers: { authorization: `Bearer ${ctx.token}` },
            })

            expect(exportRes.statusCode).toBe(StatusCodes.OK)
            const snapshot: ProjectStateSnapshot = exportRes.json()
            expect(snapshot.agents).toBeDefined()
            expect(snapshot.agents.length).toBe(1)

            const exportedAgent = snapshot.agents[0]
            expect(exportedAgent.externalId).toBe('agent-export-test')
            expect(exportedAgent.displayName).toBe('Customer Support Bot')
            expect(exportedAgent.maxSteps).toBe(15)

            const pieceTool = exportedAgent.tools.find(t => t.type === AgentToolType.PIECE)
            expect(pieceTool).toBeDefined()
            expect(pieceTool!.pieceMetadata.predefinedInput?.auth).toBe("{{connections['agent-conn-src']}}")
            expect(snapshot.requiredConnections.some(c => c.externalId === 'agent-conn-src')).toBe(true)

            const mcpTool = exportedAgent.tools.find(t => t.type === AgentToolType.MCP)
            expect(mcpTool).toBeDefined()
            expect((mcpTool as any).auth.accessToken).toBe('[REDACTED]')
        })

        it('should fail preflight when required AI provider is missing on destination', async () => {
            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                agents: [
                    {
                        externalId: 'agent-missing-provider',
                        displayName: 'Claude Agent',
                        prompt: 'Hello world',
                        maxSteps: 10,
                        model: {
                            provider: 'anthropic',
                            model: 'claude-3-5-sonnet',
                        },
                        tools: [],
                        structuredOutput: null,
                        status: 'ENABLED',
                    },
                ],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })

            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const body = planRes.json()
            expect(body.plan.preflight.passed).toBe(false)
            const missingProviderError = body.plan.preflight.errors.find(
                (e: { kind: string, details?: { provider?: string } }) => e.kind === 'MISSING_AI_PROVIDER' && e.details?.provider === 'anthropic'
            )
            expect(missingProviderError).toBeDefined()
        })

        it('should pass preflight and apply agent when AI provider is remapped to configured destination provider', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.ANTHROPIC,
                displayName: 'Anthropic Dest',
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                agents: [
                    {
                        externalId: 'agent-remapped-provider',
                        displayName: 'Support Assistant',
                        description: 'Handles tickets',
                        prompt: 'Answer politely',
                        maxSteps: 8,
                        model: {
                            provider: 'openai',
                            model: 'gpt-4o',
                        },
                        tools: [],
                        structuredOutput: null,
                        status: 'ENABLED',
                    },
                ],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const providerMappings: ProviderMappingSchema[] = [
                { sourceProvider: 'openai', destProvider: 'anthropic' },
            ]

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    snapshot: sourceSnapshot,
                    providerMappings,
                },
            })

            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(true)
            expect(artifact.plan.changes.creates.some(c => c.kind === 'agent' && c.externalId === 'agent-remapped-provider')).toBe(true)

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                    providerMappings,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const applyResult = applyRes.json()
            expect(applyResult.applied.agentsCreated).toBe(1)
            expect(applyResult.failed.length).toBe(0)

            const createdAgent = await agentService.getByExternalId({
                externalId: 'agent-remapped-provider',
                projectId: ctx.project.id,
                platformId: ctx.platform.id,
            })
            expect(createdAgent).toBeDefined()
            expect(createdAgent!.model.provider).toBe('anthropic')
            expect(createdAgent!.displayName).toBe('Support Assistant')
        })

        it('should carry provider mappings in the artifact so apply does not need them re-sent', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.ANTHROPIC,
                displayName: 'Anthropic Dest',
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                agents: [
                    {
                        externalId: 'agent-persisted-mapping',
                        displayName: 'Support Assistant',
                        description: 'Handles tickets',
                        prompt: 'Answer politely',
                        maxSteps: 8,
                        model: {
                            provider: 'openai',
                            model: 'gpt-4o',
                        },
                        tools: [],
                        structuredOutput: null,
                        status: 'ENABLED',
                    },
                ],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const providerMappings: ProviderMappingSchema[] = [
                { sourceProvider: 'openai', destProvider: 'anthropic' },
            ]

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    snapshot: sourceSnapshot,
                    providerMappings,
                },
            })

            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(true)

            // The signed plan must carry the remap, otherwise an apply from a
            // `--plan-file` has no way to know one was ever requested.
            expect(artifact.plan.providerMappings).toEqual(providerMappings)

            // Apply WITHOUT re-supplying them: the `ap project replace --plan-file` path.
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: artifact.snapshot,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const applyResult = applyRes.json()
            expect(applyResult.failed.length).toBe(0)
            expect(applyResult.applied.agentsCreated).toBe(1)

            // The agent must land on the DESTINATION provider, not the source one.
            const createdAgent = await agentService.getByExternalId({
                externalId: 'agent-persisted-mapping',
                projectId: ctx.project.id,
                platformId: ctx.platform.id,
            })
            expect(createdAgent).toBeDefined()
            expect(createdAgent!.model.provider).toBe('anthropic')
        })

        it('should still apply agents whose provider was never remapped', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.ANTHROPIC,
                displayName: 'Anthropic Dest',
            })

            const baseAgent = (externalId: string, provider: string) => ({
                externalId,
                displayName: `Agent ${externalId}`,
                description: 'Handles tickets',
                prompt: 'Answer politely',
                maxSteps: 8,
                model: { provider, model: 'gpt-4o' },
                tools: [],
                structuredOutput: null,
                status: 'ENABLED',
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                agents: [
                    baseAgent('agent-remapped-openai', 'openai'),
                    // Already on the destination provider: no mapping exists or should
                    // exist for it, and it must not be refused.
                    baseAgent('agent-native-anthropic', 'anthropic'),
                ],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const providerMappings: ProviderMappingSchema[] = [
                { sourceProvider: 'openai', destProvider: 'anthropic' },
            ]

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { snapshot: sourceSnapshot, providerMappings },
            })

            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.preflight.passed).toBe(true)

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: artifact.plan, snapshot: artifact.snapshot },
            })

            // A plan that remaps one provider must not refuse another provider's agents.
            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const applyResult = applyRes.json()
            expect(applyResult.failed.length).toBe(0)
            expect(applyResult.applied.agentsCreated).toBe(2)

            const remapped = await agentService.getByExternalId({
                externalId: 'agent-remapped-openai',
                projectId: ctx.project.id,
                platformId: ctx.platform.id,
            })
            expect(remapped!.model.provider).toBe('anthropic')

            const native = await agentService.getByExternalId({
                externalId: 'agent-native-anthropic',
                projectId: ctx.project.id,
                platformId: ctx.platform.id,
            })
            expect(native).toBeDefined()
            expect(native!.model.provider).toBe('anthropic')
        })
        it('should converge idempotently on retry with 0 duplicate agents', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.ANTHROPIC,
            })

            const sourceSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                agents: [
                    {
                        externalId: 'agent-idempotent-test',
                        displayName: 'Idempotent Agent',
                        prompt: 'Prompt 1',
                        maxSteps: 10,
                        model: {
                            provider: 'anthropic',
                            model: 'claude-3-5-sonnet',
                        },
                        tools: [],
                        structuredOutput: null,
                        status: 'ENABLED',
                    },
                ],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const plan1 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(plan1.statusCode).toBe(StatusCodes.OK)

            const apply1 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: plan1.json().plan,
                    snapshot: sourceSnapshot,
                },
            })
            expect(apply1.statusCode).toBe(StatusCodes.OK)
            expect(apply1.json().applied.agentsCreated).toBe(1)

            const plan2 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: sourceSnapshot,
            })
            expect(plan2.statusCode).toBe(StatusCodes.OK)
            const plan2Data: ProjectReplaceArtifact = plan2.json()
            expect(plan2Data.plan.changes.creates.filter(c => c.kind === 'agent').length).toBe(0)
            expect(plan2Data.plan.changes.unchanged.some(u => u.kind === 'agent' && u.externalId === 'agent-idempotent-test')).toBe(true)

            const apply2 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: plan2Data.plan,
                    snapshot: sourceSnapshot,
                },
            })
            expect(apply2.statusCode).toBe(StatusCodes.OK)
            expect(apply2.json().applied.agentsCreated).toBe(0)
            expect(apply2.json().applied.agentsUnchanged).toBe(1)

            const allAgents = await agentService.listByProjectId({ projectId: ctx.project.id })
            const matchingAgents = allAgents.filter(a => a.externalId === 'agent-idempotent-test')
            expect(matchingAgents.length).toBe(1)
        })

        it('should maintain backward compatibility by extracting agents from legacy flow definitions', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.ANTHROPIC,
            })

            const legacySnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                agents: [],
                flows: [
                    {
                        id: 'flow-legacy-1',
                        version: {
                            trigger: {
                                name: 'trigger',
                                type: 'PIECE',
                                settings: {
                                    pieceName: '@inboxfm-connect/piece-ai',
                                    input: {
                                        agentId: 'legacy-flow-agent-99',
                                        prompt: 'Agent extracted from flow',
                                        model: {
                                            provider: 'anthropic',
                                            model: 'claude-3-5-sonnet',
                                        },
                                    },
                                },
                            },
                        },
                    },
                ],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: legacySnapshot,
            })

            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const planData: ProjectReplaceArtifact = planRes.json()
            expect(planData.plan.changes.creates.some(c => c.kind === 'agent' && c.externalId === 'legacy-flow-agent-99')).toBe(true)

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: planData.plan,
                    snapshot: legacySnapshot,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            expect(applyRes.json().applied.agentsCreated).toBe(1)

            const created = await agentService.getByExternalId({
                externalId: 'legacy-flow-agent-99',
                projectId: ctx.project.id,
            })
            expect(created).toBeDefined()
            expect(created!.prompt).toBe('Agent extracted from flow')
        })

        it('should enforce dependency ordering (tables/connections before agents before trigger bindings)', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.ANTHROPIC,
            })

            await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'ordered-conn-1',
                displayName: 'Ordered Conn',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '0.1.0',
                type: AppConnectionType.SECRET_TEXT,
                value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'token' },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            const complexSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [
                    {
                        name: 'OrderedTable',
                        externalId: 'tbl-ordered-1',
                        fields: [{ name: 'col1', type: FieldType.TEXT }],
                    },
                ],
                agents: [
                    {
                        externalId: 'agent-ordered-1',
                        displayName: 'Ordered Agent',
                        prompt: 'Agent prompt',
                        maxSteps: 10,
                        model: {
                            provider: 'anthropic',
                            model: 'claude-3-5-sonnet',
                        },
                        tools: [],
                        structuredOutput: null,
                        status: 'ENABLED',
                    },
                ],
                triggerBindings: [
                    {
                        externalId: 'tb-ordered-1',
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '0.1.0',
                        triggerName: 'new_message',
                        promptTemplate: 'Run agent {{prompt}}',
                        connectionExternalId: 'ordered-conn-1',
                        settings: {},
                        propertySettings: null,
                        status: 'ENABLED',
                    },
                ],
                scheduledTasks: [
                    {
                        externalId: 'st-ordered-1',
                        prompt: 'Run daily agent task',
                        cronExpression: '0 0 * * *',
                        timezone: 'UTC',
                        status: 'ENABLED',
                    },
                ],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [
                    {
                        externalId: 'ordered-conn-1',
                        pieceName: '@inboxfm-connect/piece-slack',
                    },
                ],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: complexSnapshot,
            })

            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const planData: ProjectReplaceArtifact = planRes.json()

            const kinds = planData.plan.changes.creates.map(c => c.kind)
            const tableIdx = kinds.indexOf('table')
            const agentIdx = kinds.indexOf('agent')
            const tbIdx = kinds.indexOf('trigger_binding')
            const stIdx = kinds.indexOf('scheduled_task')

            expect(tableIdx).toBeGreaterThanOrEqual(0)
            expect(agentIdx).toBeGreaterThan(tableIdx)
            expect(tbIdx).toBeGreaterThan(agentIdx)
            expect(stIdx).toBeGreaterThan(agentIdx)
        })

        it('should maintain strict project isolation for agents with same externalId across different projects', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.ANTHROPIC,
            })

            const ctx2 = await createTestContext(app!)
            await mockAndSaveAIProvider({
                platformId: ctx2.platform.id,
                provider: AIProviderName.ANTHROPIC,
            })

            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                agents: [
                    {
                        externalId: 'shared-external-id-agent',
                        displayName: 'Project A Agent',
                        prompt: 'Prompt for Project A',
                        maxSteps: 5,
                        model: {
                            provider: 'anthropic',
                            model: 'claude-3-5-sonnet',
                        },
                        tools: [],
                        structuredOutput: null,
                        status: 'ENABLED',
                    },
                ],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const plan1 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshot,
            })
            await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: plan1.json().plan, snapshot },
            })

            const snapshot2: ProjectStateSnapshot = {
                ...snapshot,
                agents: [
                    {
                        ...snapshot.agents[0],
                        displayName: 'Project B Agent',
                        prompt: 'Prompt for Project B',
                    },
                ],
            }
            const plan2 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx2.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx2.token}` },
                body: snapshot2,
            })
            await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx2.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx2.token}` },
                body: { plan: plan2.json().plan, snapshot: snapshot2 },
            })

            const agentA = await agentService.getByExternalId({ externalId: 'shared-external-id-agent', projectId: ctx.project.id })
            const agentB = await agentService.getByExternalId({ externalId: 'shared-external-id-agent', projectId: ctx2.project.id })

            expect(agentA).toBeDefined()
            expect(agentB).toBeDefined()
            expect(agentA!.id).not.toBe(agentB!.id)
            expect(agentA!.displayName).toBe('Project A Agent')
            expect(agentB!.displayName).toBe('Project B Agent')

            const emptySnapshot: ProjectStateSnapshot = {
                ...snapshot,
                agents: [],
            }
            const planDelete = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx2.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx2.token}` },
                body: emptySnapshot,
            })
            await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx2.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx2.token}` },
                body: { plan: planDelete.json().plan, snapshot: emptySnapshot },
            })

            const agentBDeleted = await agentService.getByExternalId({ externalId: 'shared-external-id-agent', projectId: ctx2.project.id })
            const agentAStillThere = await agentService.getByExternalId({ externalId: 'shared-external-id-agent', projectId: ctx.project.id })

            expect(agentBDeleted).toBeNull()
            expect(agentAStillThere).toBeDefined()
            expect(agentAStillThere!.displayName).toBe('Project A Agent')
        })

        it('should redact unresolvable/foreign tool auth secrets on export and resolve same-project connections', async () => {
            const ctx = await createTestContext(app!)
            const ctxOther = await createTestContext(app!)

            // 1. Create connection in other project
            const foreignConn = await appConnectionService(app!.log).upsert({
                projectIds: [ctxOther.project.id],
                platformId: ctxOther.platform.id,
                externalId: 'foreign-conn',
                displayName: 'Foreign Slack Conn',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '0.1.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'foreign-token',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            // 2. Create connection in this project
            const ownConn = await appConnectionService(app!.log).upsert({
                projectIds: [ctx.project.id],
                platformId: ctx.platform.id,
                externalId: 'own-conn',
                displayName: 'Own Slack Conn',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '0.1.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'own-token',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            // 3. Create an agent in ctx.project with 3 tools:
            // a) raw literal secret
            // b) foreign connection ref
            // c) own connection ref
            await agentService.create({
                projectId: ctx.project.id,
                platformId: ctx.platform.id,
                externalId: 'secret-test-agent',
                displayName: 'Secret Test Agent',
                prompt: 'Test prompt',
                model: { provider: AIProviderName.OPENAI, model: 'gpt-4o' },
                status: 'ENABLED',
                tools: [
                    {
                        type: 'PIECE',
                        pieceMetadata: {
                            pieceName: '@inboxfm-connect/piece-slack',
                            pieceVersion: '0.1.0',
                            actionName: 'send_message',
                            predefinedInput: {
                                auth: 'sk-proj-raw-secret-token-12345',
                            },
                        },
                    },
                    {
                        type: 'PIECE',
                        pieceMetadata: {
                            pieceName: '@inboxfm-connect/piece-slack',
                            pieceVersion: '0.1.0',
                            actionName: 'send_message',
                            predefinedInput: {
                                auth: `{{connections['${foreignConn.externalId}']}}`,
                            },
                        },
                    },
                    {
                        type: 'PIECE',
                        pieceMetadata: {
                            pieceName: '@inboxfm-connect/piece-slack',
                            pieceVersion: '0.1.0',
                            actionName: 'send_message',
                            predefinedInput: {
                                auth: `{{connections['${ownConn.externalId}']}}`,
                            },
                        },
                    },
                ],
            })

            // 4. Export snapshot
            const exportRes = await app!.inject({
                method: 'GET',
                url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                headers: { authorization: `Bearer ${ctx.token}` },
            })
            expect(exportRes.statusCode).toBe(StatusCodes.OK)
            const snapshot = exportRes.json() as ProjectStateSnapshot

            const exportedAgent = snapshot.agents?.find(a => a.externalId === 'secret-test-agent')
            expect(exportedAgent).toBeDefined()
            expect(exportedAgent!.tools).toHaveLength(3)

            // Verify raw literal secret is redacted
            expect((exportedAgent!.tools[0] as unknown as { pieceMetadata: { predefinedInput: { auth: string } } }).pieceMetadata.predefinedInput.auth).toBe('[REDACTED]')

            // Verify foreign connection ref is redacted because it does not belong to this project
            expect((exportedAgent!.tools[1] as unknown as { pieceMetadata: { predefinedInput: { auth: string } } }).pieceMetadata.predefinedInput.auth).toBe('[REDACTED]')

            // Verify own connection ref is preserved
            expect((exportedAgent!.tools[2] as unknown as { pieceMetadata: { predefinedInput: { auth: string } } }).pieceMetadata.predefinedInput.auth).toBe(`{{connections['${ownConn.externalId}']}}`)
        })

        it('should reject agent preflight when connection exists on platform but in a different project', async () => {
            const ctxDest = await createTestContext(app!)
            const ctxOther = await createTestContext(app!)

            await mockAndSaveAIProvider({
                platformId: ctxDest.platform.id,
                provider: AIProviderName.OPENAI,
            })

            // Connection created in ctxOther, NOT ctxDest
            await appConnectionService(app!.log).upsert({
                projectIds: [ctxOther.project.id],
                platformId: ctxOther.platform.id,
                externalId: 'other-project-conn',
                displayName: 'Other Project Slack Conn',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '0.1.0',
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'token',
                },
                scope: AppConnectionScope.PROJECT,
                ownerId: null,
            })

            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.122.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
                agents: [
                    {
                        externalId: 'cross-project-test-agent',
                        displayName: 'Cross Project Test Agent',
                        prompt: 'Hello',
                        maxSteps: 5,
                        model: { provider: AIProviderName.OPENAI, model: 'gpt-4o' },
                        status: 'ENABLED',
                        tools: [
                            {
                                type: AgentToolType.PIECE,
                                toolName: 'send_slack',
                                pieceMetadata: {
                                    pieceName: '@inboxfm-connect/piece-slack',
                                    pieceVersion: '0.1.0',
                                    actionName: 'send_message',
                                    predefinedInput: {
                                        auth: '{{connections[\'other-project-conn\']}}',
                                        fields: {},
                                    },
                                },
                            },
                        ],
                    },
                ],
            }

            // Create plan on ctxDest
            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctxDest.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctxDest.token}` },
                body: snapshot,
            })

            expect(planRes.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const body = planRes.json()
            expect(body.plan.preflight.passed).toBe(false)
            expect(body.plan.preflight.errors.some((e: { kind: string, details?: { connectionExternalId?: string } }) =>
                e.kind === 'MISSING_CONNECTION' && e.details?.connectionExternalId === 'other-project-conn',
            )).toBe(true)
        })

        it('should extract legacy flow agents during exportSnapshot and roundtrip through plan and apply', async () => {
            const ctx = await createTestContext(app!)
            const { databaseConnection } = await import('../../../../src/app/database/database-connection')

            // Create temporary flow and flow_version tables if not exist for legacy test
            await databaseConnection().query(`
                CREATE TABLE IF NOT EXISTS "flow" (
                    "id" varchar(21) PRIMARY KEY NOT NULL,
                    "created" TIMESTAMP NOT NULL DEFAULT now(),
                    "updated" TIMESTAMP NOT NULL DEFAULT now(),
                    "projectId" varchar(21) NOT NULL,
                    "folderId" varchar(21),
                    "status" varchar NOT NULL DEFAULT 'ENABLED'
                )
            `)
            await databaseConnection().query(`
                CREATE TABLE IF NOT EXISTS "flow_version" (
                    "id" varchar(21) PRIMARY KEY NOT NULL,
                    "created" TIMESTAMP NOT NULL DEFAULT now(),
                    "updated" TIMESTAMP NOT NULL DEFAULT now(),
                    "flowId" varchar(21) NOT NULL,
                    "displayName" varchar NOT NULL,
                    "trigger" jsonb,
                    "valid" boolean NOT NULL DEFAULT true,
                    "state" varchar NOT NULL DEFAULT 'DRAFT'
                )
            `)

            const flowId = apId()
            const flowVersionId = apId()
            const legacyAgentExtId = `legacy-flow-agent-${apId()}`

            await databaseConnection().query(
                'INSERT INTO "flow" ("id", "projectId", "status") VALUES ($1, $2, $3)',
                [flowId, ctx.project.id, 'ENABLED'],
            )

            const trigger = {
                type: 'PIECE_TRIGGER',
                name: 'trigger',
                displayName: 'Webhook Trigger',
                settings: {},
                nextAction: {
                    type: 'PIECE',
                    name: 'agent_step',
                    displayName: 'Flow Legacy Agent Step',
                    settings: {
                        input: {
                            agentId: legacyAgentExtId,
                            displayName: 'Legacy Flow Assistant',
                            prompt: 'Legacy flow agent system prompt',
                            maxSteps: 8,
                            model: {
                                provider: AIProviderName.OPENAI,
                                model: 'gpt-4o',
                            },
                            agentTools: [],
                        },
                    },
                },
            }

            await databaseConnection().query(
                'INSERT INTO "flow_version" ("id", "flowId", "displayName", "trigger") VALUES ($1, $2, $3, $4)',
                [flowVersionId, flowId, 'V1', JSON.stringify(trigger)],
            )

            try {
                // Call exportSnapshot endpoint
                const exportRes = await app!.inject({
                    method: 'GET',
                    url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                    headers: { authorization: `Bearer ${ctx.token}` },
                })

                expect(exportRes.statusCode).toBe(StatusCodes.OK)
                const snapshot = exportRes.json() as ProjectStateSnapshot

                expect(snapshot.flows).toBeDefined()
                expect(snapshot.flows?.length).toBeGreaterThan(0)
                const extracted = snapshot.agents.find(a => a.externalId === legacyAgentExtId)
                expect(extracted).toBeDefined()
                expect(extracted!.displayName).toBe('Flow Legacy Agent Step')
                expect(extracted!.prompt).toBe('Legacy flow agent system prompt')
                expect(extracted!.maxSteps).toBe(8)

                // Plan and apply on target destination
                const ctxDest = await createTestContext(app!)
                await mockAndSaveAIProvider({
                    platformId: ctxDest.platform.id,
                    provider: AIProviderName.OPENAI,
                })

                const planRes = await app!.inject({
                    method: 'POST',
                    url: `/api/v1/projects/${ctxDest.project.id}/replace/plan`,
                    headers: { authorization: `Bearer ${ctxDest.token}` },
                    body: snapshot,
                })
                expect(planRes.statusCode).toBe(StatusCodes.OK)
                const planArtifact = planRes.json()
                expect(planArtifact.plan.preflight.passed).toBe(true)

                const applyRes = await app!.inject({
                    method: 'POST',
                    url: `/api/v1/projects/${ctxDest.project.id}/replace/apply`,
                    headers: { authorization: `Bearer ${ctxDest.token}` },
                    body: {
                        plan: planArtifact.plan,
                        snapshot,
                    },
                })
                expect(applyRes.statusCode).toBe(StatusCodes.OK)

                const destAgent = await agentService.getByExternalId({
                    projectId: ctxDest.project.id,
                    externalId: legacyAgentExtId,
                })
                expect(destAgent).toBeDefined()
                expect(destAgent!.prompt).toBe('Legacy flow agent system prompt')
            }
            finally {
                await databaseConnection().query('DELETE FROM "flow_version" WHERE "flowId" = $1', [flowId])
                await databaseConnection().query('DELETE FROM "flow" WHERE "id" = $1', [flowId])
            }
        })

        it('should surface preflight warning when agent tool has [REDACTED] credentials', async () => {
            const ctxDest = await createTestContext(app!)
            await mockAndSaveAIProvider({
                platformId: ctxDest.platform.id,
                provider: AIProviderName.OPENAI,
            })

            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.122.0',
                exportedAt: new Date().toISOString(),
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
                agents: [
                    {
                        externalId: 'redacted-tool-agent',
                        displayName: 'Redacted Tool Agent',
                        prompt: 'Hello',
                        maxSteps: 5,
                        model: { provider: AIProviderName.OPENAI, model: 'gpt-4o' },
                        status: 'ENABLED',
                        tools: [
                            {
                                type: AgentToolType.PIECE,
                                toolName: 'send_slack',
                                displayName: 'Send Slack',
                                pieceMetadata: {
                                    pieceName: '@inboxfm-connect/piece-slack',
                                    pieceVersion: '0.1.0',
                                    actionName: 'send_message',
                                    predefinedInput: {
                                        auth: '[REDACTED]',
                                        fields: {},
                                    },
                                },
                            },
                        ],
                    },
                ],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctxDest.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctxDest.token}` },
                body: snapshot,
            })

            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const body = planRes.json()
            expect(body.plan.preflight.passed).toBe(true)
            expect(body.plan.preflight.warnings).toBeDefined()
            expect(body.plan.preflight.warnings.length).toBeGreaterThan(0)
            const warning = body.plan.preflight.warnings.find((w: { kind: string, message: string }) => w.kind === 'REDACTED_CREDENTIAL')
            expect(warning).toBeDefined()
            expect(warning!.message).toContain('shipped with redacted credentials')
        })
    })

    describe('MCP Server Mirroring (Issue #51)', () => {
        it('should mirror MCP server configuration and redact secrets/bearer tokens from snapshot', async () => {
            await mcpServerService(app!.log).update({
                projectId: ctx.project.id,
                disabledTools: ['secret_tool_1', 'secret_tool_2'],
            })

            const exportRes = await app!.inject({
                method: 'GET',
                url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                headers: { authorization: `Bearer ${ctx.token}` },
            })

            expect(exportRes.statusCode).toBe(StatusCodes.OK)
            const snapshot: ProjectStateSnapshot = exportRes.json()
            expect(snapshot.mcp).toBeDefined()
            expect(snapshot.mcp?.externalId).toBe('default')
            expect(snapshot.mcp?.disabledTools).toContain('secret_tool_1')
            expect(snapshot.mcp?.disabledTools).toContain('secret_tool_2')
            expect((snapshot.mcp as Record<string, unknown>).token).toBeUndefined()
        })

        it('should export snapshot with mcp null when source project has no MCP server', async () => {
            await mcpServerRepository().delete({ projectId: ctx.project.id })

            const exportRes = await app!.inject({
                method: 'GET',
                url: `/api/v1/projects/${ctx.project.id}/replace/export`,
                headers: { authorization: `Bearer ${ctx.token}` },
            })

            expect(exportRes.statusCode).toBe(StatusCodes.OK)
            const snapshot: ProjectStateSnapshot = exportRes.json()
            expect(snapshot.mcp).toBeNull()
        })

        it('should update MCP disabledTools and converge idempotently on retry with 0 duplicate MCP servers', async () => {
            // Seed destination MCP
            await mcpServerService(app!.log).update({
                projectId: ctx.project.id,
                disabledTools: ['old_tool'],
            })

            const initialSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: {
                    externalId: 'default',
                    disabledTools: ['tool_alpha', 'tool_beta'],
                },
                requiredPieces: [],
                requiredConnections: [],
            }

            // Plan 1: expect UPDATE
            const planRes1 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: initialSnapshot,
            })
            expect(planRes1.statusCode).toBe(StatusCodes.OK)
            const artifact1: ProjectReplaceArtifact = planRes1.json()
            expect(artifact1.plan.changes.updates.some((u) => u.kind === 'mcp_server')).toBe(true)

            // Apply 1
            const applyRes1 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: artifact1.plan, snapshot: initialSnapshot },
            })
            expect(applyRes1.statusCode).toBe(StatusCodes.OK)
            expect(applyRes1.json().applied.mcpUpdated).toBe(1)

            // Verify MCP in destination
            const destMcp = await mcpServerRepository().findOneBy({ projectId: ctx.project.id })
            expect(destMcp).toBeDefined()
            expect(destMcp!.disabledTools).toEqual(['tool_alpha', 'tool_beta'])

            // Plan 2: re-run mirror with the same snapshot -> should be UNCHANGED
            const planRes2 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: initialSnapshot,
            })
            expect(planRes2.statusCode).toBe(StatusCodes.OK)
            const artifact2: ProjectReplaceArtifact = planRes2.json()
            expect(artifact2.plan.changes.unchanged.some((u) => u.kind === 'mcp_server')).toBe(true)
            expect(artifact2.plan.changes.updates.some((u) => u.kind === 'mcp_server')).toBe(false)

            // Apply 2: retry should converge with 0 updates and 1 unchanged
            const applyRes2 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: artifact2.plan, snapshot: initialSnapshot },
            })
            expect(applyRes2.statusCode).toBe(StatusCodes.OK)
            expect(applyRes2.json().applied.mcpUpdated).toBe(0)
            expect(applyRes2.json().applied.mcpUnchanged).toBe(1)

            // Check exactly ONE MCP server exists in DB for this project
            const mcpCount = await mcpServerRepository().countBy({ projectId: ctx.project.id })
            expect(mcpCount).toBe(1)
        })

        it('should delete destination MCP server configuration when snapshot.mcp is null', async () => {
            // Seed destination MCP
            await mcpServerService(app!.log).update({
                projectId: ctx.project.id,
                disabledTools: ['tool_to_delete'],
            })
            expect(await mcpServerRepository().findOneBy({ projectId: ctx.project.id })).toBeDefined()

            const deleteSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: null,
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: deleteSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.changes.deletes.some((d) => d.kind === 'mcp_server')).toBe(true)

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: artifact.plan, snapshot: deleteSnapshot },
            })
            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            expect(applyRes.json().applied.mcpDeleted).toBe(1)

            const deletedMcp = await mcpServerRepository().findOneBy({ projectId: ctx.project.id })
            expect(deletedMcp).toBeNull()
        })

        it('should reject cross-project plan application with 403', async () => {
            const ctx2 = await createTestContext(app!)

            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { externalId: 'default', disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            // Create plan targeting ctx.project.id
            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Attempt to apply ctx's plan against ctx2.project.id
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx2.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx2.token}` },
                body: { plan: artifact.plan, snapshot },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('should rotate destination MCP token safely and return credential via one-time response channel without leaking to snapshot or plan', async () => {
            const initialMcp = await mcpServerService(app!.log).getByProjectId(ctx.project.id)
            const originalToken = initialMcp.token

            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { externalId: 'default', disabledTools: ['rotated_tool'] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()

            // Apply with rotateMcpToken: true
            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot,
                    rotateMcpToken: true,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const result = applyRes.json()
            expect(result.mcpCredentials).toBeDefined()
            expect(result.mcpCredentials.token).toBeDefined()
            expect(result.mcpCredentials.token).not.toBe(originalToken)

            // Verify DB has the new token
            const updatedMcp = await mcpServerRepository().findOneBy({ projectId: ctx.project.id })
            expect(updatedMcp?.token).toBe(result.mcpCredentials.token)

            // Verify neither plan nor snapshot contained the new token
            expect(JSON.stringify(artifact)).not.toContain(result.mcpCredentials.token)
            expect(JSON.stringify(snapshot)).not.toContain(result.mcpCredentials.token)

            // Subsequent apply without rotateMcpToken does NOT return token
            const plan2 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshot,
            })
            const apply2 = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: plan2.json().plan, snapshot },
            })
            expect(apply2.json().mcpCredentials).toBeNull()
        })

        it('should emit CREATE when destination has no MCP server and increment mcpCreated upon apply', async () => {
            const createSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: {
                    externalId: 'default',
                    disabledTools: ['tool_fresh'],
                },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: createSnapshot,
            })
            expect(planRes.statusCode).toBe(StatusCodes.OK)
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.changes.creates.some((c) => c.kind === 'mcp_server')).toBe(true)

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: artifact.plan, snapshot: createSnapshot },
            })
            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            expect(applyRes.json().applied.mcpCreated).toBe(1)

            const createdMcp = await mcpServerRepository().findOneBy({ projectId: ctx.project.id })
            expect(createdMcp).toBeDefined()
            expect(createdMcp!.disabledTools).toEqual(['tool_fresh'])
        })

        it('should reject plan application with empty targetProjectId with 403', async () => {
            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { externalId: 'default', disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshot,
            })
            const artifact: ProjectReplaceArtifact = planRes.json()

            const forgedPlan = {
                ...artifact.plan,
                targetProjectId: '',
            }

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: forgedPlan, snapshot },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('should not resurrect MCP server when snapshot.mcp is null and rotateMcpToken is true', async () => {
            await mcpServerService(app!.log).update({
                projectId: ctx.project.id,
                disabledTools: ['tool_to_delete'],
            })
            expect(await mcpServerRepository().findOneBy({ projectId: ctx.project.id })).toBeDefined()

            const deleteSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: null,
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: deleteSnapshot,
            })
            const artifact: ProjectReplaceArtifact = planRes.json()
            expect(artifact.plan.changes.deletes.some((d) => d.kind === 'mcp_server')).toBe(true)

            const applyRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: {
                    plan: artifact.plan,
                    snapshot: deleteSnapshot,
                    rotateMcpToken: true,
                },
            })

            expect(applyRes.statusCode).toBe(StatusCodes.OK)
            const result = applyRes.json()
            expect(result.applied.mcpDeleted).toBe(1)
            expect(result.mcpCredentials).toBeNull()

            const finalMcp = await mcpServerRepository().findOneBy({ projectId: ctx.project.id })
            expect(finalMcp).toBeNull()
        })

        it('should capture MCP rotation failure into failed array with op ROTATE', async () => {
            await mcpServerService(app!.log).update({
                projectId: ctx.project.id,
                disabledTools: [],
            })

            const snapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: { externalId: 'default', disabledTools: [] },
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: snapshot,
            })
            const artifact: ProjectReplaceArtifact = planRes.json()

            const repo = mcpServerRepository()
            const updateSpy = vi.spyOn(repo, 'update').mockRejectedValueOnce(new Error('KMS encryption key unavailable'))

            try {
                const applyRes = await app!.inject({
                    method: 'POST',
                    url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                    headers: { authorization: `Bearer ${ctx.token}` },
                    body: {
                        plan: artifact.plan,
                        snapshot,
                        rotateMcpToken: true,
                    },
                })

                expect(applyRes.statusCode).toBe(StatusCodes.MULTI_STATUS)
                const result = applyRes.json()
                expect(result.mcpCredentials).toBeNull()
                expect(result.failed.some((f: { kind: string, externalId: string, op: string, error: string }) => f.kind === 'mcp_server' && f.externalId === 'default' && f.op === 'ROTATE' && f.error.includes('KMS encryption key unavailable'))).toBe(true)
            }
            finally {
                updateSpy.mockRestore()
            }
        })

        it('should recover from partial failure during MCP delete phase', async () => {
            await mcpServerService(app!.log).update({
                projectId: ctx.project.id,
                disabledTools: ['tool_fail_delete'],
            })

            const deleteSnapshot: ProjectStateSnapshot = {
                schemaVersion: 1,
                sourceActivepiecesVersion: '0.120.0',
                exportedAt: new Date().toISOString(),
                sourceEnvironment: { projectId: apId() },
                tables: [],
                triggerBindings: [],
                scheduledTasks: [],
                mcp: null,
                requiredPieces: [],
                requiredConnections: [],
            }

            const planRes = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/plan`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: deleteSnapshot,
            })
            const artifact: ProjectReplaceArtifact = planRes.json()

            const repo = mcpServerRepository()
            const deleteSpy = vi.spyOn(repo, 'delete').mockRejectedValueOnce(new Error('Lock wait timeout exceeded'))

            const failApply = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: artifact.plan, snapshot: deleteSnapshot },
            })

            expect(failApply.statusCode).toBe(StatusCodes.MULTI_STATUS)
            expect(failApply.json().failed.some((f: any) => f.kind === 'mcp_server' && f.op === 'DELETE')).toBe(true)
            expect(failApply.json().applied.mcpDeleted).toBe(0)
            deleteSpy.mockRestore()

            expect(await mcpServerRepository().findOneBy({ projectId: ctx.project.id })).toBeDefined()

            const retryApply = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ctx.project.id}/replace/apply`,
                headers: { authorization: `Bearer ${ctx.token}` },
                body: { plan: artifact.plan, snapshot: deleteSnapshot },
            })

            expect(retryApply.statusCode).toBe(StatusCodes.OK)
            expect(retryApply.json().applied.mcpDeleted).toBe(1)
            expect(await mcpServerRepository().findOneBy({ projectId: ctx.project.id })).toBeNull()
        })
    })
})
