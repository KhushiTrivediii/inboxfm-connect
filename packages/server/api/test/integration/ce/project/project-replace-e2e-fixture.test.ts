import crypto from 'crypto'
import { AIProviderName, apId } from '@inboxfm-connect/core-utils'
import {
    AgentToolType,
    AppConnectionScope,
    AppConnectionType,
    ConnectionMappingSchema,
    FieldType,
    ProjectReplaceArtifact,
    ProjectStateSnapshot,
    ScheduledTaskStatus,
} from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentService } from '../../../../src/app/agents/agent.service'
import { appConnectionService } from '../../../../src/app/app-connection/app-connection-service/app-connection-service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { fieldService } from '../../../../src/app/tables/field/field.service'
import { tableService } from '../../../../src/app/tables/table/table.service'
import { scheduledTaskService } from '../../../../src/app/execution/scheduled-task/scheduled-task.service'
import { mockAndSaveAIProvider } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Project Replace E2E Multi-Project Fixture (#128)', () => {
    let sourceCtx: TestContext
    let destCtx: TestContext

    beforeEach(async () => {
        sourceCtx = await createTestContext(app!)
        destCtx = await createTestContext(app!)

        // Seed AI Provider on destination platform so plan validation passes
        await mockAndSaveAIProvider({
            platformId: destCtx.platform.id,
            provider: AIProviderName.OPENAI,
        })
    })

    /**
     * Computes a canonical SHA-256 state hash of all entities belonging to a project.
     * Used to verify the dry-run zero-mutation invariant.
     */
    async function computeProjectDbChecksum(projectId: string): Promise<string> {
        const ds = databaseConnection()

        const tables = await ds.query(
            'SELECT "id", "name", "externalId" FROM "table" WHERE "projectId" = $1 ORDER BY "id" ASC',
            [projectId],
        )
        const fields = await ds.query(
            'SELECT "id", "name", "type", "tableId" FROM "field" WHERE "tableId" IN (SELECT "id" FROM "table" WHERE "projectId" = $1) ORDER BY "id" ASC',
            [projectId],
        )
        const agents = await ds.query(
            'SELECT "id", "displayName", "externalId", "model" FROM "agent" WHERE "projectId" = $1 ORDER BY "id" ASC',
            [projectId],
        )
        const connections = await ds.query(
            'SELECT "id", "externalId", "pieceName", "type" FROM "app_connection" WHERE $1 = ANY("projectIds") ORDER BY "id" ASC',
            [projectId],
        )
        const scheduledTasks = await ds.query(
            'SELECT "id", "prompt", "cronExpression", "status" FROM "scheduled_task" WHERE "projectId" = $1 ORDER BY "id" ASC',
            [projectId],
        )
        const triggerBindings = await ds.query(
            'SELECT "id", "pieceName", "triggerName" FROM "trigger_binding" WHERE "projectId" = $1 ORDER BY "id" ASC',
            [projectId],
        )
        const mcpServers = await ds.query(
            'SELECT "id", "token" FROM "mcp_server" WHERE "projectId" = $1 ORDER BY "id" ASC',
            [projectId],
        )

        const canonicalPayload = JSON.stringify({
            tables,
            fields,
            agents,
            connections,
            scheduledTasks,
            triggerBindings,
            mcpServers,
        })
        return crypto.createHash('sha256').update(canonicalPayload).digest('hex')
    }

    it('executes full export -> plan -> apply workflow across two projects with real connections and verified remapping', async () => {
        // 1. Seed Real Source Connection in Project A
        const sourceConn = await appConnectionService(app!.log).upsert({
            projectIds: [sourceCtx.project.id],
            platformId: sourceCtx.platform.id,
            externalId: 'conn-source-slack',
            displayName: 'Source Slack Connection',
            pieceName: '@inboxfm-connect/piece-slack',
            pieceVersion: '0.17.3',
            type: AppConnectionType.SECRET_TEXT,
            value: {
                type: AppConnectionType.SECRET_TEXT,
                secret_text: 'xoxb-source-secret-token-111',
            },
            scope: AppConnectionScope.PROJECT,
            ownerId: null,
        })

        // 2. Seed Real Entities in Project A (Source)
        const sourceTable = await tableService.create({
            projectId: sourceCtx.project.id,
            request: {
                name: 'Customers',
                externalId: 'customers-table-ext',
                fields: [
                    { name: 'email', type: FieldType.TEXT },
                    { name: 'score', type: FieldType.NUMBER },
                ],
            },
        })

        const sourceAgent = await agentService.create({
            projectId: sourceCtx.project.id,
            platformId: sourceCtx.platform.id,
            externalId: 'agent-support-bot',
            displayName: 'Support Notification Bot',
            description: 'Notifies support channel',
            prompt: 'You send support alerts.',
            maxSteps: 10,
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
                        pieceVersion: '0.17.3',
                        actionName: 'send_message',
                        predefinedInput: {
                            auth: sourceConn.id,
                            fields: {},
                        },
                    },
                },
            ],
        })

        const sourceTask = await scheduledTaskService.create({
            projectId: sourceCtx.project.id,
            platformId: sourceCtx.platform.id,
            request: {
                prompt: 'Run customer report',
                cronExpression: '0 9 * * 1',
                timezone: 'UTC',
                status: ScheduledTaskStatus.ENABLED,
            },
        })

        // 3. Seed Real Destination Connection in Project B
        const destConn = await appConnectionService(app!.log).upsert({
            projectIds: [destCtx.project.id],
            platformId: destCtx.platform.id,
            externalId: 'conn-dest-slack',
            displayName: 'Destination Slack Connection',
            pieceName: '@inboxfm-connect/piece-slack',
            pieceVersion: '0.17.3',
            type: AppConnectionType.SECRET_TEXT,
            value: {
                type: AppConnectionType.SECRET_TEXT,
                secret_text: 'xoxb-dest-secret-token-999',
            },
            scope: AppConnectionScope.PROJECT,
            ownerId: null,
        })

        // 4. EXPORT: Export snapshot from Source Project A
        const exportRes = await app!.inject({
            method: 'GET',
            url: `/api/v1/projects/${sourceCtx.project.id}/replace/export`,
            headers: { authorization: `Bearer ${sourceCtx.token}` },
        })

        expect(exportRes.statusCode).toBe(StatusCodes.OK)
        const snapshot: ProjectStateSnapshot = exportRes.json()
        expect(snapshot.schemaVersion).toBe(1)
        expect(snapshot.sourceEnvironment?.projectId).toBe(sourceCtx.project.id)
        expect(snapshot.tables.some(t => t.name === 'Customers')).toBe(true)
        expect(snapshot.agents?.some(a => a.externalId === 'agent-support-bot')).toBe(true)
        expect(snapshot.scheduledTasks?.some(s => s.cronExpression === '0 9 * * 1')).toBe(true)
        expect(snapshot.requiredConnections.some(c => c.externalId === 'conn-source-slack')).toBe(true)

        // 5. DRY-RUN NO-MUTATION INVARIANT: Checksum destination DB state before and after plan
        const prePlanChecksum = await computeProjectDbChecksum(destCtx.project.id)

        const connectionMappings: ConnectionMappingSchema[] = [
            {
                sourceExternalId: 'conn-source-slack',
                destExternalId: 'conn-dest-slack',
            },
        ]

        // 6. PLAN: Generate dry-run plan for Destination Project B
        const planRes = await app!.inject({
            method: 'POST',
            url: `/api/v1/projects/${destCtx.project.id}/replace/plan`,
            headers: { authorization: `Bearer ${destCtx.token}` },
            body: {
                snapshot,
                connectionMappings,
            },
        })

        expect(planRes.statusCode).toBe(StatusCodes.OK)
        const planArtifact: ProjectReplaceArtifact = planRes.json()
        expect(planArtifact.plan.targetProjectId).toBe(destCtx.project.id)
        expect(planArtifact.plan.preflight.passed).toBe(true)
        expect(planArtifact.plan.summary.created).toBeGreaterThan(0)

        // INVARIANT ASSERTION: Destination DB was NOT mutated during plan generation
        const postPlanChecksum = await computeProjectDbChecksum(destCtx.project.id)
        expect(postPlanChecksum).toBe(prePlanChecksum)

        // 7. APPLY: Apply plan to Destination Project B
        const applyRes = await app!.inject({
            method: 'POST',
            url: `/api/v1/projects/${destCtx.project.id}/replace/apply`,
            headers: { authorization: `Bearer ${destCtx.token}` },
            body: {
                plan: planArtifact.plan,
                snapshot,
                connectionMappings,
            },
        })

        expect(applyRes.statusCode).toBe(StatusCodes.OK)
        const applyResult = applyRes.json()
        expect(applyResult.failed).toEqual([])
        expect(applyResult.applied.tablesCreated).toBe(1)
        expect(applyResult.applied.agentsCreated).toBe(1)
        expect(applyResult.applied.scheduledTasksCreated).toBe(1)

        // 8. CONNECTION REMAP VERIFICATION: Dest agent tool uses dest connection, not source
        const appliedAgent = await agentService.getByExternalId({
            projectId: destCtx.project.id,
            externalId: 'agent-support-bot',
        })

        expect(appliedAgent).toBeDefined()
        expect(appliedAgent!.projectId).toBe(destCtx.project.id)
        const appliedTool = appliedAgent!.tools.find(t => t.toolName === 'send_slack_message')
        expect(appliedTool).toBeDefined()

        // Auth reference must be remapped to the destination connection's ID, not source
        const appliedAuth = appliedTool!.pieceMetadata.predefinedInput.auth
        expect(appliedAuth).toBe(`{{connections['${destConn.id}']}}`)
        expect(appliedAuth).not.toContain(sourceConn.id)

        // 9. CROSS-PROJECT ISOLATION: Source project was NOT mutated, no leakage
        const sourceConnAfter = await appConnectionService(app!.log).getOne({
            id: sourceConn.id,
            platformId: sourceCtx.platform.id,
            projectId: sourceCtx.project.id,
        })
        expect(sourceConnAfter).toBeDefined()
        expect(sourceConnAfter.projectIds).toEqual([sourceCtx.project.id])
        expect(sourceConnAfter.externalId).toBe('conn-source-slack')

        const destConnAfter = await appConnectionService(app!.log).getOne({
            id: destConn.id,
            platformId: destCtx.platform.id,
            projectId: destCtx.project.id,
        })
        expect(destConnAfter).toBeDefined()
        expect(destConnAfter.projectIds).toEqual([destCtx.project.id])
        expect(destConnAfter.externalId).toBe('conn-dest-slack')

        // Verify source project entities remain intact and unmutated
        const sourceAgents = await agentService.listByProjectId({ projectId: sourceCtx.project.id })
        expect(sourceAgents.length).toBe(1)
        expect(sourceAgents[0].id).toBe(sourceAgent.id)
        expect(sourceAgents[0].projectId).toBe(sourceCtx.project.id)

        const sourceTasks = await scheduledTaskService.list({
            projectId: sourceCtx.project.id,
            platformId: sourceCtx.platform.id,
        })
        expect(sourceTasks.data.length).toBe(1)
        expect(sourceTasks.data[0].id).toBe(sourceTask.id)
        expect(sourceTasks.data[0].projectId).toBe(sourceCtx.project.id)

        const sourceTables = await tableService.list({ projectId: sourceCtx.project.id })
        expect(sourceTables.data.length).toBe(1)
        expect(sourceTables.data[0].id).toBe(sourceTable.id)
        expect(sourceTables.data[0].projectId).toBe(sourceCtx.project.id)

        // Verify destination entities belong strictly to destination project
        const destAgents = await agentService.listByProjectId({ projectId: destCtx.project.id })
        expect(destAgents.length).toBe(1)
        expect(destAgents[0].id).not.toBe(sourceAgent.id)
        expect(destAgents[0].projectId).toBe(destCtx.project.id)

        const destTasks = await scheduledTaskService.list({
            projectId: destCtx.project.id,
            platformId: destCtx.platform.id,
        })
        expect(destTasks.data.length).toBe(1)
        expect(destTasks.data[0].id).not.toBe(sourceTask.id)
        expect(destTasks.data[0].projectId).toBe(destCtx.project.id)

        const destTables = await tableService.list({ projectId: destCtx.project.id })
        expect(destTables.data.length).toBe(1)
        expect(destTables.data[0].name).toBe('Customers')
        expect(destTables.data[0].id).not.toBe(sourceTable.id)
        expect(destTables.data[0].projectId).toBe(destCtx.project.id)

        const destFields = await fieldService.getAll({
            projectId: destCtx.project.id,
            tableId: destTables.data[0].id,
        })
        expect(destFields.length).toBe(2)
        expect(destFields.map(f => f.name).sort()).toEqual(['email', 'score'])
    })

    it('surfaces REDACTED_CREDENTIAL warning in preflight when an agent tool carries [REDACTED] credentials', async () => {
        const snapshotWithRedacted: ProjectStateSnapshot = {
            schemaVersion: 1,
            sourceActivepiecesVersion: '0.120.0',
            exportedAt: new Date().toISOString(),
            sourceEnvironment: { projectId: sourceCtx.project.id },
            tables: [],
            triggerBindings: [],
            scheduledTasks: [],
            mcp: { disabledTools: [] },
            requiredPieces: [],
            requiredConnections: [],
            agents: [
                {
                    externalId: 'agent-redacted-fixture',
                    displayName: 'Redacted Tool Agent',
                    prompt: 'You require slack.',
                    maxSteps: 5,
                    model: { provider: AIProviderName.OPENAI, model: 'gpt-4o' },
                    status: 'ENABLED',
                    tools: [
                        {
                            type: AgentToolType.PIECE,
                            toolName: 'send_slack',
                            displayName: 'Send Slack Message',
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
            url: `/api/v1/projects/${destCtx.project.id}/replace/plan`,
            headers: { authorization: `Bearer ${destCtx.token}` },
            body: snapshotWithRedacted,
        })

        expect(planRes.statusCode).toBe(StatusCodes.OK)
        const body: ProjectReplaceArtifact = planRes.json()
        expect(body.plan.preflight.passed).toBe(true)
        expect(body.plan.preflight.warnings).toBeDefined()

        const redactedWarning = body.plan.preflight.warnings.find(w => w.kind === 'REDACTED_CREDENTIAL')
        expect(redactedWarning).toBeDefined()
        expect(redactedWarning!.message).toContain('shipped with redacted credentials')
        expect(redactedWarning!.details).toMatchObject({
            agentExternalId: 'agent-redacted-fixture',
            toolName: 'send_slack',
            pieceName: '@inboxfm-connect/piece-slack',
        })
    })
})
