import crypto from 'crypto'
import { AIProviderName, apId, ApMultipartFile } from '@inboxfm-connect/core-utils'
import { apVersionUtil } from '@inboxfm-connect/server-utils'
import {
    AgentSnapshotSchema,
    AgentTool,
    AppConnectionScope,
    AppConnectionType,
    AppConnectionValue,
    ConnectionMappingSchema,
    ConnectionPreflightReportSchema,
    CreateFieldRequest,
    Field,
    FieldType,
    McpAuthType,
    McpServerSnapshotSchema,
    PackageType,
    PieceScope,
    PieceType,
    PreflightError,
    ProjectReplaceApplyRequest,
    ProjectReplaceApplyResult,
    ProjectReplaceDiffItem,
    ProjectReplaceOp,
    ProjectReplacePlan,
    ProjectReplaceResourceKind,
    ProjectStateSnapshot,
    ProviderMappingSchema,
    RequiredPieceSchema,
    ScheduledTaskStatus,
    Table,
    TableAutomationStatus,
    TableAutomationTrigger,
    TriggerBindingStatus,
} from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import semver from 'semver'
import { ArrayContains, In } from 'typeorm'
import { AgentEntity, AgentSchema } from '../../agents/agent.entity'
import { agentService } from '../../agents/agent.service'
import { AIProviderEntity, AIProviderSchema } from '../../ai/ai-provider-entity'
import { appConnectionService } from '../../app-connection/app-connection-service/app-connection-service'
import { ConnectionEntity, ConnectionSchema } from '../../app-connection/app-connection.entity'
import { repoFactory } from '../../core/db/repo-factory'
import { databaseConnection } from '../../database/database-connection'
import { distributedLock } from '../../database/redis-connections'
import { ScheduledTaskEntity } from '../../execution/scheduled-task/scheduled-task-entity'
import { scheduledTaskService } from '../../execution/scheduled-task/scheduled-task.service'
import { TriggerBindingEntity } from '../../execution/trigger-binding/trigger-binding-entity'
import { triggerBindingService } from '../../execution/trigger-binding/trigger-binding.service'
import { fileRepo } from '../../file/file.service'
import { flagService } from '../../flags/flag.service'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { mcpServerRepository, mcpServerService } from '../../mcp/mcp-service'
import { PieceMetadataSchema } from '../../pieces/metadata/piece-metadata-entity'
import { pieceMetadataService } from '../../pieces/metadata/piece-metadata-service'
import { pieceFilteringHooks } from '../../pieces/metadata/utils/piece-filtering-hooks'
import { pieceInstallService } from '../../pieces/piece-install-service'
import { fieldService } from '../../tables/field/field.service'
import { TableEntity } from '../../tables/table/table.entity'
import { tableService } from '../../tables/table/table.service'


const tableRepo = repoFactory(TableEntity)
const triggerBindingRepo = repoFactory(TriggerBindingEntity)
const scheduledTaskRepo = repoFactory(ScheduledTaskEntity)
const connectionRepo = repoFactory(ConnectionEntity)
const agentRepo = repoFactory<AgentSchema>(AgentEntity)
const aiProviderRepo = repoFactory<AIProviderSchema>(AIProviderEntity)

const RESOURCE_CREATE_ORDER: Record<ProjectReplaceResourceKind, number> = {
    custom_piece: 0,
    connection: 1,
    table: 2,
    agent: 3,
    trigger_binding: 4,
    scheduled_task: 5,
    mcp_server: 6,
}

const RESOURCE_DELETE_ORDER: Record<ProjectReplaceResourceKind, number> = {
    mcp_server: 0,
    scheduled_task: 1,
    trigger_binding: 2,
    agent: 3,
    table: 4,
    connection: 5,
    custom_piece: 6,
}

function parseConnectionRef(auth: unknown): string | null {
    if (typeof auth !== 'string') return null
    const match = auth.match(/^\{\{connections\['([^']+)'\]\}\}$/) || auth.match(/^\{\{connections\["([^"]+)"\]\}\}$/)
    if (match) return match[1]
    return auth
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase()
        if (lower.includes('auth') || lower.includes('token') || lower.includes('key') || lower.includes('secret') || lower.includes('bearer')) {
            sanitized[key] = '[REDACTED]'
        }
        else {
            sanitized[key] = value
        }
    }
    return sanitized
}

function sanitizeMcpTool(tool: AgentTool): AgentTool {
    if (tool.type !== 'MCP') return tool
    const auth = tool.auth
    if (!auth || auth.type === McpAuthType.NONE) return tool

    if (auth.type === McpAuthType.ACCESS_TOKEN) {
        return {
            ...tool,
            auth: {
                type: McpAuthType.ACCESS_TOKEN,
                accessToken: '[REDACTED]',
            },
        }
    }
    if (auth.type === McpAuthType.API_KEY) {
        return {
            ...tool,
            auth: {
                type: McpAuthType.API_KEY,
                apiKey: '[REDACTED]',
                apiKeyHeader: auth.apiKeyHeader,
            },
        }
    }
    if (auth.type === McpAuthType.HEADERS) {
        return {
            ...tool,
            auth: {
                type: McpAuthType.HEADERS,
                headers: sanitizeHeaders(auth.headers),
            },
        }
    }
    return tool
}

function isTableNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') {
        return false
    }
    const errObj = err as Record<string, unknown>
    if (errObj.code === '42P01') {
        return true
    }
    const message = typeof errObj.message === 'string' ? errObj.message.toLowerCase() : ''
    if (
        message.includes('does not exist') ||
        message.includes('no such table') ||
        message.includes('undefined_table') ||
        message.includes('relation "flow"') ||
        message.includes('relation "flow_version"')
    ) {
        return true
    }
    return false
}

function extractAgentsFromFlows(flows?: Array<Record<string, unknown>>): AgentSnapshotSchema[] {
    if (!flows || !Array.isArray(flows)) return []
    const agents: AgentSnapshotSchema[] = []
    const seenExtIds = new Set<string>()

    for (const flow of flows) {
        if (!flow || typeof flow !== 'object') continue
        const flowVersion = (flow.version ?? flow) as Record<string, unknown>
        if (!flowVersion || typeof flowVersion !== 'object') continue
        const trigger = flowVersion.trigger as Record<string, unknown> | undefined
        if (!trigger || typeof trigger !== 'object') continue

        const steps: Array<Record<string, unknown>> = []
        const visited = new Set<Record<string, unknown>>()
        const collectSteps = (step?: Record<string, unknown>): void => {
            if (!step || typeof step !== 'object' || visited.has(step)) return
            visited.add(step)
            steps.push(step)
            if (step.nextAction && typeof step.nextAction === 'object') {
                collectSteps(step.nextAction as Record<string, unknown>)
            }
            if (Array.isArray(step.children)) {
                for (const c of step.children) {
                    if (c && typeof c === 'object') {
                        collectSteps(c as Record<string, unknown>)
                    }
                }
            }
        }
        collectSteps(trigger)

        for (const step of steps) {
            const settings = step.settings as Record<string, unknown> | undefined
            if (!settings || typeof settings !== 'object') continue
            const input = settings.input as Record<string, unknown> | undefined
            if (!input || typeof input !== 'object') continue

            const agentId = (input.agentId ?? input.externalAgentId) as string | undefined
            if (agentId && typeof agentId === 'string' && agentId.trim().length > 0 && !seenExtIds.has(agentId)) {
                seenExtIds.add(agentId)
                const modelInput = input.model && typeof input.model === 'object' ? (input.model as { provider?: string, model?: string }) : undefined
                agents.push({
                    externalId: agentId,
                    displayName: (step.displayName as string) ?? (step.name as string) ?? `Flow Agent (${agentId})`,
                    description: (step.description as string) ?? 'Agent extracted from legacy flow definition',
                    prompt: (input.prompt as string) ?? '',
                    maxSteps: typeof input.maxSteps === 'number' ? input.maxSteps : 10,
                    model: {
                        provider: modelInput?.provider ?? (typeof input.provider === 'string' ? input.provider : ''),
                        model: modelInput?.model ?? (typeof input.modelName === 'string' ? input.modelName : ''),
                    },
                    tools: Array.isArray(input.agentTools) ? (input.agentTools as AgentTool[]) : [],
                    structuredOutput: null,
                    status: 'ENABLED',
                })
            }
        }
    }

    return agents
}

function normalizeToolsForComparison(tools: AgentTool[], connectionMappings?: ConnectionMappingSchema[]): AgentTool[] {
    const connMap = new Map<string, string>()
    if (connectionMappings) {
        for (const cm of connectionMappings) {
            if (cm.destExternalId) connMap.set(cm.sourceExternalId, cm.destExternalId)
        }
    }

    return (tools ?? []).map((t) => {
        if (t.type === 'PIECE') {
            const rawAuth = t.pieceMetadata?.predefinedInput?.auth
            let normalizedAuth = rawAuth
            if (rawAuth) {
                const ref = parseConnectionRef(rawAuth)
                if (ref) {
                    const mappedRef = connMap.get(ref) ?? ref
                    normalizedAuth = `{{connections['${mappedRef}']}}`
                }
            }
            return {
                ...t,
                pieceMetadata: {
                    ...t.pieceMetadata,
                    ...(normalizedAuth ? {
                        predefinedInput: {
                            fields: t.pieceMetadata.predefinedInput?.fields ?? {},
                            auth: normalizedAuth,
                        },
                    } : {}),
                },
            }
        }
        if (t.type === 'MCP') {
            return sanitizeMcpTool(t)
        }
        return t
    })
}

function remapAgentTools(
    tools: AgentTool[],
    resolvedConnections: Map<string, string>,
    connectionMappings?: ConnectionMappingSchema[],
    existingTools?: AgentTool[],
): AgentTool[] {
    const getMcpToolKey = (t: AgentTool): string => {
        const mcp = t.type === 'MCP' ? (t as unknown as { serverUrl?: string, serverExternalId?: string, serverName?: string, toolName: string }) : null
        const serverId = mcp?.serverUrl || mcp?.serverExternalId || mcp?.serverName || 'default'
        return `${serverId}::${t.toolName}`
    }

    const existingMcpMap = new Map<string, AgentTool>()
    if (existingTools) {
        for (const et of existingTools) {
            if (et.type === 'MCP') {
                existingMcpMap.set(getMcpToolKey(et), et)
            }
        }
    }

    const connMap = new Map<string, string>()
    if (connectionMappings) {
        for (const cm of connectionMappings) {
            if (cm.destExternalId) connMap.set(cm.sourceExternalId, cm.destExternalId)
        }
    }

    return (tools ?? []).map((t) => {
        if (t.type === 'PIECE') {
            const rawAuth = t.pieceMetadata?.predefinedInput?.auth
            if (rawAuth) {
                const ref = parseConnectionRef(rawAuth)
                if (ref) {
                    const destExtId = resolvedConnections.get(ref) ?? connMap.get(ref) ?? ref
                    return {
                        ...t,
                        pieceMetadata: {
                            ...t.pieceMetadata,
                            predefinedInput: {
                                fields: t.pieceMetadata.predefinedInput?.fields ?? {},
                                auth: `{{connections['${destExtId}']}}`,
                            },
                        },
                    }
                }
            }
            return t
        }
        if (t.type === 'MCP') {
            const existing = existingMcpMap.get(getMcpToolKey(t))
            if (existing && existing.type === 'MCP') {
                let preservedAuth = t.auth
                if (t.auth.type === McpAuthType.ACCESS_TOKEN && t.auth.accessToken === '[REDACTED]' && existing.auth.type === McpAuthType.ACCESS_TOKEN) {
                    preservedAuth = existing.auth
                }
                else if (t.auth.type === McpAuthType.API_KEY && t.auth.apiKey === '[REDACTED]' && existing.auth.type === McpAuthType.API_KEY) {
                    preservedAuth = existing.auth
                }
                else if (t.auth.type === McpAuthType.HEADERS && existing.auth.type === McpAuthType.HEADERS) {
                    const mergedHeaders = { ...t.auth.headers }
                    for (const [k, v] of Object.entries(mergedHeaders)) {
                        if (v === '[REDACTED]' && existing.auth.headers[k]) {
                            mergedHeaders[k] = existing.auth.headers[k]
                        }
                    }
                    preservedAuth = {
                        type: McpAuthType.HEADERS,
                        headers: mergedHeaders,
                    }
                }
                return {
                    ...t,
                    auth: preservedAuth,
                }
            }
            return t
        }
        return t
    })
}

function getSigningSecret(): string {
    const dedicatedSecret = system.get(AppSystemProp.PROJECT_REPLACE_SIGNING_SECRET)
    if (dedicatedSecret) {
        return dedicatedSecret
    }
    const envSecret = process.env.PROJECT_REPLACE_SIGNING_SECRET || process.env.AP_PROJECT_REPLACE_SIGNING_SECRET
    if (envSecret) {
        return envSecret
    }
    const jwtSecret = system.get(AppSystemProp.JWT_SECRET)
    if (jwtSecret) {
        return jwtSecret
    }
    throw new Error('Signing secret is not configured. PROJECT_REPLACE_SIGNING_SECRET or JWT_SECRET must be set.')
}

function canonicalJson(obj: unknown): string {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj)
    }
    if (Array.isArray(obj)) {
        return '[' + obj.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']'
    }
    const keys = Object.keys(obj as Record<string, unknown>).sort()
    const entries: string[] = []
    for (const key of keys) {
        const val = (obj as Record<string, unknown>)[key]
        if (val !== undefined) {
            entries.push(`${JSON.stringify(key)}:${canonicalJson(val)}`)
        }
    }
    return '{' + entries.join(',') + '}'
}

function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function computeSha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

function sanitizeMappingForPlan(m: ConnectionMappingSchema): Omit<ConnectionMappingSchema, 'value'> {
    return {
        sourceExternalId: m.sourceExternalId,
        destExternalId: m.destExternalId,
        destConnectionId: m.destConnectionId,
        pieceName: m.pieceName,
        type: m.type,
        displayName: m.displayName,
    }
}

function computePlanSignature(plan: Omit<ProjectReplacePlan, 'signature'>): string {
    const secret = getSigningSecret()
    const canonicalPayload = canonicalJson({
        planId: plan.planId,
        schemaVersion: plan.schemaVersion,
        toolVersion: plan.toolVersion,
        sourceActivepiecesVersion: plan.sourceActivepiecesVersion,
        targetActivepiecesVersion: plan.targetActivepiecesVersion,
        targetProjectId: plan.targetProjectId,
        checksum: plan.checksum,
        destinationStateHash: plan.destinationStateHash,
        preflight: plan.preflight,
        connectionMappings: (plan.connectionMappings ?? []).map(sanitizeMappingForPlan),
        providerMappings: (plan.providerMappings ?? []).map((pm: ProviderMappingSchema) => ({
            sourceProvider: pm.sourceProvider,
            destProvider: pm.destProvider,
        })),
        changes: plan.changes,
        summary: plan.summary,
    })
    return crypto.createHmac('sha256', secret).update(canonicalPayload).digest('hex')
}

export const projectReplaceService = (log: FastifyBaseLogger) => ({
    async exportSnapshot({ projectId, platformId }: { projectId: string, platformId: string }): Promise<ProjectStateSnapshot> {
        const currentVersion = apVersionUtil.getCurrentRelease()

        // 1. Tables (schema only, zero records)
        const tables = await tableRepo().find({ where: { projectId } })
        const tablesSnapshot = []
        for (const tbl of tables) {
            const fields: Field[] = await fieldService.getAll({ projectId, tableId: tbl.id })
            tablesSnapshot.push({
                name: tbl.name,
                externalId: tbl.externalId ?? tbl.id,
                fields: fields.map((f: Field) => ({
                    name: f.name,
                    type: f.type,
                    externalId: f.externalId ?? f.id,
                })),
                status: tbl.status ?? null,
                trigger: tbl.trigger ?? null,
            })
        }

        // 2. Trigger bindings
        const triggerBindings = await triggerBindingRepo().find({ where: { projectId } })
        const triggerBindingsSnapshot = []
        const requiredPiecesMap = new Map<string, string>()
        const requiredConnectionsMap = new Map<string, string>()

        // One batched lookup for every referenced connection instead of one
        // findOne per binding: identical filters (platform + project membership),
        // identical results - ids are the primary key, so In() returns each
        // referenced connection at most once - in a single round trip.
        const referencedConnectionIds = Array.from(new Set(
            triggerBindings.map((tb) => tb.connectionId).filter((id): id is string => id != null),
        ))
        const connectionsById = new Map<string, ConnectionSchema>()
        if (referencedConnectionIds.length > 0) {
            const connections = await connectionRepo().find({
                where: {
                    id: In(referencedConnectionIds),
                    platformId,
                    projectIds: ArrayContains([projectId]),
                },
            })
            for (const conn of connections) {
                connectionsById.set(conn.id, conn)
            }
        }

        for (const tb of triggerBindings) {
            requiredPiecesMap.set(`${tb.pieceName}::${tb.pieceVersion}`, tb.pieceVersion)
            let connExternalId: string | null = null
            if (tb.connectionId) {
                const conn = connectionsById.get(tb.connectionId)
                if (conn && conn.externalId) {
                    connExternalId = conn.externalId
                    requiredConnectionsMap.set(conn.externalId, conn.pieceName)
                }
            }

            triggerBindingsSnapshot.push({
                externalId: tb.id,
                pieceName: tb.pieceName,
                pieceVersion: tb.pieceVersion,
                triggerName: tb.triggerName,
                promptTemplate: tb.promptTemplate,
                connectionExternalId: connExternalId,
                settings: (tb.settings as Record<string, unknown>) ?? {},
                propertySettings: (tb.propertySettings as Record<string, unknown>) ?? null,
                status: tb.status,
            })
        }

        // 3. Scheduled tasks
        const scheduledTasks = await scheduledTaskRepo().find({ where: { projectId } })
        const scheduledTasksSnapshot = scheduledTasks.map((st) => ({
            externalId: st.id,
            prompt: st.prompt,
            cronExpression: st.cronExpression,
            timezone: st.timezone,
            status: st.status,
        }))

        // 4. Agents (mirror complete definitions, model/provider references, tool bindings, sanitize secrets)
        const agents = await agentRepo().find({ where: { projectId } })
        const agentsSnapshot: AgentSnapshotSchema[] = []
        for (const ag of agents) {
            const sanitizedTools: AgentTool[] = []
            for (const tool of (ag.tools ?? [])) {
                if (tool.type === 'PIECE') {
                    requiredPiecesMap.set(tool.pieceMetadata.pieceName, tool.pieceMetadata.pieceVersion)
                    let toolCopy = { ...tool, pieceMetadata: { ...tool.pieceMetadata } }
                    if (tool.pieceMetadata.predefinedInput?.auth) {
                        const rawAuth = tool.pieceMetadata.predefinedInput.auth
                        const ref = parseConnectionRef(rawAuth)
                        let resolvedAuth = '[REDACTED]'
                        if (ref) {
                            const conn = await connectionRepo().findOne({
                                where: [
                                    { id: ref, platformId, projectIds: ArrayContains([projectId]) },
                                    { externalId: ref, platformId, projectIds: ArrayContains([projectId]) },
                                ],
                            })
                            if (conn && conn.externalId) {
                                requiredConnectionsMap.set(conn.externalId, conn.pieceName)
                                resolvedAuth = `{{connections['${conn.externalId}']}}`
                            }
                        }
                        toolCopy = {
                            ...toolCopy,
                            pieceMetadata: {
                                ...toolCopy.pieceMetadata,
                                predefinedInput: {
                                    fields: tool.pieceMetadata.predefinedInput?.fields ?? {},
                                    auth: resolvedAuth,
                                },
                            },
                        }
                    }
                    sanitizedTools.push(toolCopy)
                }
                else if (tool.type === 'MCP') {
                    sanitizedTools.push(sanitizeMcpTool(tool))
                }
                else {
                    sanitizedTools.push(tool)
                }
            }

            agentsSnapshot.push({
                externalId: ag.externalId,
                displayName: ag.displayName,
                description: ag.description ?? null,
                prompt: ag.prompt,
                maxSteps: ag.maxSteps,
                model: ag.model,
                tools: sanitizedTools,
                structuredOutput: ag.structuredOutput ?? null,
                status: ag.status === 'DISABLED' ? 'DISABLED' : 'ENABLED',
            })
        }

        // 4.5. Legacy flow agents (if legacy flow table exists in DB)
        let flowsSnapshot: Array<Record<string, unknown>> = []
        try {
            const flows = await databaseConnection().query<Array<Record<string, unknown>>>(
                'SELECT * FROM "flow" WHERE "projectId" = $1',
                [projectId],
            )
            if (Array.isArray(flows) && flows.length > 0) {
                const flowIds = flows.map((f) => f.id as string).filter(Boolean)
                let flowVersions: Array<Record<string, unknown>> = []
                if (flowIds.length > 0) {
                    const placeholders = flowIds.map((_, i) => `$${i + 1}`).join(', ')
                    flowVersions = await databaseConnection().query<Array<Record<string, unknown>>>(
                        `SELECT * FROM "flow_version" WHERE "flowId" IN (${placeholders}) ORDER BY "created" DESC`,
                        flowIds,
                    )
                }
                const versionsByFlowId = new Map<string, Record<string, unknown>>()
                for (const fv of flowVersions) {
                    const flowId = fv.flowId as string
                    if (!flowId) continue
                    const existing = versionsByFlowId.get(flowId)
                    if (!existing) {
                        versionsByFlowId.set(flowId, fv)
                    }
                    else {
                        const existingCreated = new Date((existing.created as string | number | Date) ?? 0).getTime()
                        const currentCreated = new Date((fv.created as string | number | Date) ?? 0).getTime()
                        if (currentCreated > existingCreated) {
                            versionsByFlowId.set(flowId, fv)
                        }
                    }
                }

                flowsSnapshot = flows.map((f) => ({
                    ...f,
                    version: versionsByFlowId.get(f.id as string) ?? f.version,
                }))

                const extractedAgents = extractAgentsFromFlows(flowsSnapshot)
                for (const ea of extractedAgents) {
                    if (!agentsSnapshot.some((a) => a.externalId === ea.externalId)) {
                        agentsSnapshot.push(ea)
                    }
                }
            }
        }
        catch (err) {
            if (isTableNotFoundError(err)) {
                flowsSnapshot = []
            }
            else {
                throw err
            }
        }

        // 5. MCP server (externalId and disabledTools only, NO live bearer tokens!)
        const mcpServer = await mcpServerRepository().findOneBy({ projectId })
        const mcpSnapshot: McpServerSnapshotSchema | null = mcpServer
            ? {
                externalId: 'default',
                disabledTools: mcpServer.disabledTools ?? [],
            }
            : null

        const requiredPieces: RequiredPieceSchema[] = []
        const customPieces: RequiredPieceSchema[] = []

        for (const [key, version] of requiredPiecesMap.entries()) {
            const [name] = key.split('::')
            const pieceMeta = await pieceMetadataService(log).get({ name, version, platformId })
            let pieceType: 'OFFICIAL' | 'CUSTOM' = 'OFFICIAL'
            let packageType: 'ARCHIVE' | 'REGISTRY' = 'REGISTRY'
            let archiveChecksum: string | undefined
            let archiveFileBase64: string | undefined
            const minimumSupportedRelease = pieceMeta?.minimumSupportedRelease ?? undefined
            const maximumSupportedRelease = pieceMeta?.maximumSupportedRelease ?? undefined

            if (pieceMeta?.pieceType === PieceType.CUSTOM) {
                pieceType = 'CUSTOM'
                if (pieceMeta.packageType === PackageType.ARCHIVE && pieceMeta.archiveId) {
                    packageType = 'ARCHIVE'
                    const file = await fileRepo().findOneBy({ id: pieceMeta.archiveId, platformId })
                    if (file?.data) {
                        archiveChecksum = crypto.createHash('sha256').update(file.data).digest('hex')
                        archiveFileBase64 = file.data.toString('base64')
                    }
                }
            }

            const pieceInfo: RequiredPieceSchema = {
                name,
                version,
                pieceType,
                packageType,
                archiveChecksum,
                minimumSupportedRelease,
                maximumSupportedRelease,
                archiveFileBase64,
            }
            requiredPieces.push(pieceInfo)
            if (pieceType === 'CUSTOM') {
                customPieces.push(pieceInfo)
            }
        }

        const requiredConnections = Array.from(requiredConnectionsMap.entries()).map(([externalId, pieceName]) => ({
            externalId,
            pieceName,
        }))

        return {
            schemaVersion: 1,
            sourceActivepiecesVersion: currentVersion,
            exportedAt: new Date().toISOString(),
            sourceEnvironment: {
                platformId,
                projectId,
            },
            tables: tablesSnapshot,
            agents: agentsSnapshot,
            triggerBindings: triggerBindingsSnapshot,
            scheduledTasks: scheduledTasksSnapshot,
            mcp: mcpSnapshot,
            requiredPieces,
            customPieces,
            requiredConnections,
            flows: flowsSnapshot,
        }
    },

    async computeDestinationStateHash(projectId: string, platformId?: string): Promise<string> {
        const tables = await tableRepo().find({ where: { projectId } })
        // One batched fields query instead of one getAll per table:
        // getAllByTableIds orders each table's fields by position ASC exactly
        // like getAll, and the hash sorts the mapped fields by externalId
        // afterwards, so the normalized state is byte-identical.
        const fieldsByTable = await fieldService.getAllByTableIds({
            projectId,
            tableIds: tables.map((t) => t.id),
        })
        const tablesWithFields = []
        for (const t of tables) {
            const fields: Field[] = fieldsByTable.get(t.id) ?? []
            tablesWithFields.push({
                name: t.name,
                externalId: t.externalId,
                status: t.status ?? null,
                trigger: t.trigger ?? null,
                fields: fields.map((f: Field) => ({ name: f.name, type: f.type, externalId: f.externalId ?? f.id })).sort((a, b) => (a.externalId || '').localeCompare(b.externalId || '')),
            })
        }

        const agents = await agentRepo().find({ where: { projectId } })
        const triggerBindings = await triggerBindingRepo().find({ where: { projectId } })
        const scheduledTasks = await scheduledTaskRepo().find({ where: { projectId } })
        const mcpServer = await mcpServerRepository().findOneBy({ projectId })
        const connections = await connectionRepo().find({
            where: {
                projectIds: ArrayContains([projectId]),
                ...(platformId ? { platformId } : {}),
            },
        })

        const normalized = {
            tables: tablesWithFields.sort((a, b) => (a.externalId || '').localeCompare(b.externalId || '')),
            agents: agents.map((a) => ({
                externalId: a.externalId,
                displayName: a.displayName,
                description: a.description ?? null,
                prompt: a.prompt,
                maxSteps: a.maxSteps,
                model: {
                    provider: a.model.provider,
                    model: a.model.model,
                },
                tools: a.tools.map(sanitizeMcpTool),
                structuredOutput: a.structuredOutput ?? null,
                status: a.status,
            })).sort((a, b) => a.externalId.localeCompare(b.externalId)),
            triggerBindings: triggerBindings.map((tb) => ({
                pieceName: tb.pieceName,
                pieceVersion: tb.pieceVersion,
                triggerName: tb.triggerName,
                promptTemplate: tb.promptTemplate,
                connectionId: tb.connectionId,
                status: tb.status,
                settings: tb.settings,
                propertySettings: tb.propertySettings,
            })).sort((a, b) => (a.pieceName + a.triggerName).localeCompare(b.pieceName + b.triggerName)),
            scheduledTasks: scheduledTasks.map((st) => ({
                prompt: st.prompt,
                cronExpression: st.cronExpression,
                timezone: st.timezone,
                status: st.status,
            })).sort((a, b) => `${a.prompt}:${a.cronExpression}`.localeCompare(`${b.prompt}:${b.cronExpression}`)),
            mcp: mcpServer ? { externalId: 'default', disabledTools: [...(mcpServer.disabledTools ?? [])].sort() } : null,
            connections: connections.map((c) => ({
                externalId: c.externalId,
                pieceName: c.pieceName,
                type: c.type,
                status: c.status,
            })).sort((a, b) => (a.externalId || '').localeCompare(b.externalId || '')),
        }

        return computeSha256(canonicalJson(normalized))
    },

    async createPlan({
        targetProjectId,
        targetPlatformId,
        snapshot,
        connectionMappings,
        providerMappings,
    }: {
        targetProjectId: string
        targetPlatformId: string
        snapshot: ProjectStateSnapshot
        connectionMappings?: ConnectionMappingSchema[]
        providerMappings?: ProviderMappingSchema[]
    }): Promise<ProjectReplacePlan> {
        const currentVersion = apVersionUtil.getCurrentRelease()
        const preflightErrors: PreflightError[] = []
        const preflightWarnings: PreflightError[] = []

        // 1. Preflight: Version skew
        const sourceSemver = semver.valid(semver.coerce(snapshot.sourceActivepiecesVersion))
        const targetSemver = semver.valid(semver.coerce(currentVersion))
        if (!sourceSemver || !targetSemver) {
            preflightErrors.push({
                kind: 'VERSION_SKEW',
                message: `Invalid version string: source="${snapshot.sourceActivepiecesVersion}", destination="${currentVersion}".`,
            })
        }
        else {
            const sourceMajor = semver.major(sourceSemver)
            const targetMajor = semver.major(targetSemver)
            if (sourceMajor > targetMajor) {
                preflightErrors.push({
                    kind: 'VERSION_SKEW',
                    message: `Source major version (${snapshot.sourceActivepiecesVersion}) is newer than destination (${currentVersion}).`,
                })
            }
        }

        const creates: ProjectReplaceDiffItem[] = []
        const updates: ProjectReplaceDiffItem[] = []
        const deletes: ProjectReplaceDiffItem[] = []
        const unchanged: Array<{ kind: ProjectReplaceResourceKind, externalId: string }> = []

        // 2. Preflight: Required pieces & custom integrations
        const customIntegrations = {
            required: [] as RequiredPieceSchema[],
            missing: [] as RequiredPieceSchema[],
            deployable: [] as RequiredPieceSchema[],
            compatible: [] as RequiredPieceSchema[],
        }

        // Process distinct piece name + version combinations
        const seenPieces = new Set<string>()
        const allPiecesToVerify = [...(snapshot.requiredPieces || []), ...(snapshot.customPieces || [])]

        for (const reqPiece of allPiecesToVerify) {
            const pieceKey = `${reqPiece.name}@${reqPiece.version}`
            if (seenPieces.has(pieceKey)) {
                continue
            }
            seenPieces.add(pieceKey)

            const isCustom = reqPiece.pieceType === 'CUSTOM'
                || snapshot.customPieces?.some((cp) => cp.name === reqPiece.name && cp.version === reqPiece.version)
                || Boolean(reqPiece.archiveFileBase64)

            let destPiece = null
            try {
                destPiece = await pieceMetadataService(log).getOrThrow({
                    name: reqPiece.name,
                    version: reqPiece.version,
                    projectId: targetProjectId,
                    platformId: targetPlatformId,
                })
            }
            catch {
                destPiece = null
            }

            if (isCustom) {
                customIntegrations.required.push(reqPiece)

                // Compatibility check applies to all custom integrations (installed or missing)
                let isCompatible = true
                const minReleaseStr = reqPiece.minimumSupportedRelease ?? destPiece?.minimumSupportedRelease
                const maxReleaseStr = reqPiece.maximumSupportedRelease ?? destPiece?.maximumSupportedRelease
                const minRelease = minReleaseStr ? semver.valid(semver.coerce(minReleaseStr)) : null
                const maxRelease = maxReleaseStr ? semver.valid(semver.coerce(maxReleaseStr)) : null

                if (minRelease && targetSemver && semver.lt(targetSemver, minRelease)) {
                    isCompatible = false
                    preflightErrors.push({
                        kind: 'INCOMPATIBLE_INTEGRATION',
                        message: `Custom integration ${reqPiece.name}@${reqPiece.version} requires engine >= ${minReleaseStr}, but destination is running ${currentVersion}.`,
                        details: { pieceName: reqPiece.name, version: reqPiece.version, minimumSupportedRelease: minReleaseStr },
                    })
                }
                if (maxRelease && targetSemver && semver.gt(targetSemver, maxRelease)) {
                    isCompatible = false
                    preflightErrors.push({
                        kind: 'INCOMPATIBLE_INTEGRATION',
                        message: `Custom integration ${reqPiece.name}@${reqPiece.version} requires engine <= ${maxReleaseStr}, but destination is running ${currentVersion}.`,
                        details: { pieceName: reqPiece.name, version: reqPiece.version, maximumSupportedRelease: maxReleaseStr },
                    })
                }
                if (isCompatible) {
                    customIntegrations.compatible.push(reqPiece)
                }

                if (!destPiece) {
                    customIntegrations.missing.push(reqPiece)

                    // Package integrity and deployability check
                    if (reqPiece.archiveFileBase64) {
                        // Integrity verification: Checksum MUST be present for archive deployment
                        if (!reqPiece.archiveChecksum) {
                            preflightErrors.push({
                                kind: 'CHECKSUM_MISMATCH',
                                message: `Integrity checksum verification failed for custom piece ${reqPiece.name}@${reqPiece.version}: missing required archiveChecksum.`,
                                details: { pieceName: reqPiece.name, version: reqPiece.version },
                            })
                        }
                        else {
                            const artifactBuf = Buffer.from(reqPiece.archiveFileBase64, 'base64')
                            const computedChecksum = crypto.createHash('sha256').update(artifactBuf).digest('hex')
                            if (computedChecksum !== reqPiece.archiveChecksum) {
                                preflightErrors.push({
                                    kind: 'CHECKSUM_MISMATCH',
                                    message: `Integrity checksum verification failed for custom piece ${reqPiece.name}@${reqPiece.version}. Expected ${reqPiece.archiveChecksum}, computed ${computedChecksum}.`,
                                    details: { pieceName: reqPiece.name, expected: reqPiece.archiveChecksum, computed: computedChecksum },
                                })
                            }
                            else if (isCompatible) {
                                customIntegrations.deployable.push(reqPiece)
                                creates.push({
                                    kind: 'custom_piece',
                                    externalId: `${reqPiece.name}::${reqPiece.version}`,
                                    op: 'CREATE',
                                    name: `${reqPiece.name}@${reqPiece.version}`,
                                    description: `Deploy custom integration ${reqPiece.name}@${reqPiece.version}`,
                                })
                            }
                        }
                    }
                    else {
                        preflightErrors.push({
                            kind: 'MISSING_CUSTOM_PIECE',
                            message: `Required custom integration ${reqPiece.name}@${reqPiece.version} is not installed on destination. Provide an integrity-checked artifact or deploy it beforehand.`,
                            details: { pieceName: reqPiece.name, version: reqPiece.version },
                        })
                    }
                }
                else {
                    // Already installed custom piece: only mark unchanged if compatible!
                    if (isCompatible) {
                        unchanged.push({
                            kind: 'custom_piece',
                            externalId: `${reqPiece.name}::${reqPiece.version}`,
                        })
                    }
                }
            }
            else {
                if (!destPiece) {
                    preflightErrors.push({
                        kind: 'MISSING_PIECE',
                        message: `Required piece ${reqPiece.name}@${reqPiece.version} is not installed or available on destination.`,
                        details: { pieceName: reqPiece.name, version: reqPiece.version },
                    })
                }
            }
        }

        // 3. Preflight: Required connections & connection mapping workflow
        const connectionsReport: ConnectionPreflightReportSchema = {
            required: [],
            matched: [],
            missing: [],
            mapped: [],
        }

        const mappingsMap = new Map<string, ConnectionMappingSchema>()
        if (connectionMappings) {
            for (const cm of connectionMappings) {
                mappingsMap.set(cm.sourceExternalId, cm)
            }
        }

        for (const reqConn of snapshot.requiredConnections) {
            connectionsReport.required.push({
                externalId: reqConn.externalId,
                pieceName: reqConn.pieceName,
            })

            const mapping = mappingsMap.get(reqConn.externalId)
            if (mapping) {
                if (mapping.value) {
                    // Bootstrap mapping with credentials
                    const destExtId = mapping.destExternalId ?? reqConn.externalId
                    const mappedPieceName = mapping.pieceName ?? reqConn.pieceName
                    if (mappedPieceName !== reqConn.pieceName) {
                        preflightErrors.push({
                            kind: 'INCOMPATIBLE_CONNECTION',
                            message: `Connection mapping for source "${reqConn.externalId}" specifies piece "${mappedPieceName}", but source requires "${reqConn.pieceName}".`,
                            details: {
                                sourceExternalId: reqConn.externalId,
                                expectedPiece: reqConn.pieceName,
                                actualPiece: mappedPieceName,
                            },
                        })
                    }
                    else {
                        // Check if already exists on destination platform scoped to targetProjectId
                        const existingConn = await connectionRepo().findOne({
                            where: {
                                externalId: destExtId,
                                platformId: targetPlatformId,
                                projectIds: ArrayContains([targetProjectId]),
                            },
                        })
                        if (existingConn) {
                            if (existingConn.pieceName !== reqConn.pieceName) {
                                preflightErrors.push({
                                    kind: 'INCOMPATIBLE_CONNECTION',
                                    message: `Destination connection "${destExtId}" already exists for piece "${existingConn.pieceName}", but source requires "${reqConn.pieceName}".`,
                                    details: {
                                        externalId: destExtId,
                                        existingPiece: existingConn.pieceName,
                                        requiredPiece: reqConn.pieceName,
                                    },
                                })
                            }
                            else {
                                connectionsReport.matched.push({
                                    sourceExternalId: reqConn.externalId,
                                    destExternalId: destExtId,
                                    destConnectionId: existingConn.id,
                                    pieceName: existingConn.pieceName,
                                    status: existingConn.status,
                                })
                                unchanged.push({ kind: 'connection', externalId: destExtId })
                            }
                        }
                        else {
                            creates.push({
                                kind: 'connection',
                                externalId: destExtId,
                                op: 'CREATE',
                                name: mapping.displayName ?? destExtId,
                                description: `Bootstrap destination connection for ${reqConn.pieceName} (${destExtId})`,
                            })
                        }

                        connectionsReport.mapped.push({
                            sourceExternalId: reqConn.externalId,
                            destExternalId: destExtId,
                            destConnectionId: existingConn ? existingConn.id : undefined,
                            pieceName: mappedPieceName,
                            mappingType: 'BOOTSTRAP',
                        })
                    }
                }
                else {
                    // Remap mapping to existing destination connection
                    const targetLookup = mapping.destExternalId
                        ? await connectionRepo().findOne({
                            where: {
                                externalId: mapping.destExternalId,
                                platformId: targetPlatformId,
                                projectIds: ArrayContains([targetProjectId]),
                            },
                        })
                        : mapping.destConnectionId
                            ? await connectionRepo().findOne({
                                where: {
                                    id: mapping.destConnectionId,
                                    platformId: targetPlatformId,
                                    projectIds: ArrayContains([targetProjectId]),
                                },
                            })
                            : null

                    const targetRef = mapping.destExternalId ?? mapping.destConnectionId ?? 'unknown'
                    if (!targetLookup) {
                        preflightErrors.push({
                            kind: 'MISSING_CONNECTION',
                            message: `Mapped destination connection "${targetRef}" for source "${reqConn.externalId}" does not exist on destination.`,
                            details: {
                                sourceExternalId: reqConn.externalId,
                                mappedDestinationRef: targetRef,
                                pieceName: reqConn.pieceName,
                                actionableHelp: 'Create the destination connection or provide bootstrap credentials in connectionMappings.',
                            },
                        })
                        connectionsReport.missing.push({
                            externalId: reqConn.externalId,
                            pieceName: reqConn.pieceName,
                            actionableHelp: `Create destination connection "${targetRef}" or supply credentials via --connection-bootstrap.`,
                        })
                    }
                    else if (targetLookup.pieceName !== reqConn.pieceName) {
                        preflightErrors.push({
                            kind: 'INCOMPATIBLE_CONNECTION',
                            message: `Mapped destination connection "${targetLookup.externalId}" has piece "${targetLookup.pieceName}", but source requires "${reqConn.pieceName}".`,
                            details: {
                                sourceExternalId: reqConn.externalId,
                                mappedExternalId: targetLookup.externalId,
                                expectedPiece: reqConn.pieceName,
                                actualPiece: targetLookup.pieceName,
                            },
                        })
                    }
                    else {
                        connectionsReport.matched.push({
                            sourceExternalId: reqConn.externalId,
                            destExternalId: targetLookup.externalId,
                            destConnectionId: targetLookup.id,
                            pieceName: targetLookup.pieceName,
                            status: targetLookup.status,
                        })
                        connectionsReport.mapped.push({
                            sourceExternalId: reqConn.externalId,
                            destExternalId: targetLookup.externalId,
                            destConnectionId: targetLookup.id,
                            pieceName: targetLookup.pieceName,
                            mappingType: 'REMAP',
                        })
                        unchanged.push({ kind: 'connection', externalId: targetLookup.externalId })
                    }
                }
            }
            else {
                // No explicit mapping provided: check 1:1 match by externalId scoped to targetProjectId
                const destConn = await connectionRepo().findOne({
                    where: {
                        externalId: reqConn.externalId,
                        platformId: targetPlatformId,
                        projectIds: ArrayContains([targetProjectId]),
                    },
                })
                if (!destConn) {
                    preflightErrors.push({
                        kind: 'MISSING_CONNECTION',
                        message: `Required connection with externalId "${reqConn.externalId}" (${reqConn.pieceName}) does not exist on destination.`,
                        details: {
                            externalId: reqConn.externalId,
                            pieceName: reqConn.pieceName,
                            actionableHelp: `Supply connection mapping via --connection-map ${reqConn.externalId}=<destExternalId> or bootstrap credentials via CI secret store.`,
                        },
                    })
                    connectionsReport.missing.push({
                        externalId: reqConn.externalId,
                        pieceName: reqConn.pieceName,
                        actionableHelp: `Supply connection mapping or bootstrap credentials for "${reqConn.externalId}".`,
                    })
                }
                else if (destConn.pieceName !== reqConn.pieceName) {
                    preflightErrors.push({
                        kind: 'INCOMPATIBLE_CONNECTION',
                        message: `Destination connection "${reqConn.externalId}" is for piece "${destConn.pieceName}", but source requires "${reqConn.pieceName}".`,
                        details: {
                            externalId: reqConn.externalId,
                            existingPiece: destConn.pieceName,
                            requiredPiece: reqConn.pieceName,
                        },
                    })
                }
                else {
                    connectionsReport.matched.push({
                        sourceExternalId: reqConn.externalId,
                        destExternalId: destConn.externalId,
                        destConnectionId: destConn.id,
                        pieceName: destConn.pieceName,
                        status: destConn.status,
                    })
                    connectionsReport.mapped.push({
                        sourceExternalId: reqConn.externalId,
                        destExternalId: destConn.externalId,
                        destConnectionId: destConn.id,
                        pieceName: destConn.pieceName,
                        mappingType: 'EXISTING_MATCH',
                    })
                    unchanged.push({ kind: 'connection', externalId: destConn.externalId })
                }
            }
        }

        // 3.5. Preflight: AI Providers and Agent Tool Connections
        const effectiveAgents: AgentSnapshotSchema[] = [...(snapshot.agents ?? [])]
        if (snapshot.flows && snapshot.flows.length > 0) {
            const flowAgents = extractAgentsFromFlows(snapshot.flows)
            for (const fa of flowAgents) {
                if (!effectiveAgents.some((a) => a.externalId === fa.externalId)) {
                    effectiveAgents.push(fa)
                }
            }
        }

        const providerMap = new Map<string, string>()
        if (providerMappings) {
            for (const pm of providerMappings) {
                providerMap.set(pm.sourceProvider.toLowerCase(), pm.destProvider)
            }
        }

        for (const agent of effectiveAgents) {
            const rawProvider = agent.model.provider
            const mappedProvider = providerMap.get(rawProvider.toLowerCase()) ?? rawProvider

            const standardProvider = Object.values(AIProviderName).find(p => p.toLowerCase() === mappedProvider.toLowerCase())
            const isStandardProvider = Boolean(standardProvider)
            if (!isStandardProvider && mappedProvider.toLowerCase() !== 'activepieces') {
                preflightErrors.push({
                    kind: 'INCOMPATIBLE_AI_PROVIDER',
                    message: `AI provider "${mappedProvider}" specified for agent "${agent.displayName}" (${agent.externalId}) is not a recognized or supported provider.`,
                    details: {
                        agentExternalId: agent.externalId,
                        sourceProvider: rawProvider,
                        mappedProvider,
                    },
                })
                continue
            }

            let isAvailable = false
            if (mappedProvider.toLowerCase() === AIProviderName.ACTIVEPIECES.toLowerCase() || mappedProvider.toLowerCase() === 'activepieces') {
                const activepiecesExists = await aiProviderRepo().findOne({
                    where: {
                        platformId: targetPlatformId,
                        provider: AIProviderName.ACTIVEPIECES,
                    },
                })
                const creditsEnabled = flagService(log).aiCreditsEnabled()
                isAvailable = Boolean(activepiecesExists) || creditsEnabled
            }
            else {
                isAvailable = await aiProviderRepo().existsBy({
                    platformId: targetPlatformId,
                    provider: (standardProvider ?? mappedProvider) as AIProviderName,
                })
            }

            if (!isAvailable) {
                preflightErrors.push({
                    kind: 'MISSING_AI_PROVIDER',
                    message: `Required AI provider "${mappedProvider}" for agent "${agent.displayName}" (${agent.externalId}) is not configured on destination platform.`,
                    details: {
                        agentExternalId: agent.externalId,
                        sourceProvider: rawProvider,
                        provider: mappedProvider,
                        effectiveProvider: mappedProvider,
                        actionableHelp: `Configure provider "${mappedProvider}" on destination or supply --provider-map ${rawProvider}=<destProvider>.`,
                    },
                })
            }

            for (const tool of (agent.tools ?? [])) {
                if (tool.type === 'PIECE' && tool.pieceMetadata?.predefinedInput?.auth) {
                    const rawAuth = tool.pieceMetadata.predefinedInput.auth
                    if (rawAuth === '[REDACTED]') {
                        preflightWarnings.push({
                            kind: 'REDACTED_CREDENTIAL',
                            message: `Tool "${tool.toolName}" on agent "${agent.displayName}" (${agent.externalId}) shipped with redacted credentials — connection must be configured or re-authenticated on destination.`,
                            details: {
                                agentExternalId: agent.externalId,
                                toolName: tool.toolName,
                                pieceName: tool.pieceMetadata.pieceName,
                                actionableHelp: 'Configure or re-authenticate connection on destination.',
                            },
                        })
                    }
                    else {
                        const ref = parseConnectionRef(rawAuth)
                        if (ref) {
                            const isMatched = connectionsReport.matched.some(m => m.sourceExternalId === ref || m.destExternalId === ref)
                            const isMapped = connectionsReport.mapped.some(m => m.sourceExternalId === ref)
                            const isBootstrap = Boolean(mappingsMap.get(ref)?.value)
                            if (!isMatched && !isMapped && !isBootstrap) {
                                const destConn = await connectionRepo().findOne({
                                    where: {
                                        externalId: ref,
                                        platformId: targetPlatformId,
                                        projectIds: ArrayContains([targetProjectId]),
                                    },
                                })
                                if (!destConn && !connectionsReport.missing.some(m => m.externalId === ref)) {
                                    preflightErrors.push({
                                        kind: 'MISSING_CONNECTION',
                                        message: `Required connection "${ref}" for agent "${agent.displayName}" tool (${tool.pieceMetadata.pieceName}) does not exist on destination.`,
                                        details: {
                                            agentExternalId: agent.externalId,
                                            connectionExternalId: ref,
                                            pieceName: tool.pieceMetadata.pieceName,
                                            actionableHelp: `Supply connection mapping via --connection-map ${ref}=<destExternalId> or bootstrap credentials.`,
                                        },
                                    })
                                    connectionsReport.missing.push({
                                        externalId: ref,
                                        pieceName: tool.pieceMetadata.pieceName,
                                        actionableHelp: `Supply connection mapping or bootstrap credentials for "${ref}".`,
                                    })
                                }
                            }
                        }
                    }
                }
            }
        }

        // 4. Current destination state & state hash
        const destinationStateHash = await this.computeDestinationStateHash(targetProjectId, targetPlatformId)

        // Tables Diff
        const destTables = await tableRepo().find({ where: { projectId: targetProjectId } })
        const destTableMap = new Map<string, Table>()
        for (const dt of destTables) {
            destTableMap.set(dt.externalId ?? dt.id, dt)
        }

        const sourceTableExtIds = new Set<string>()
        for (const srcTable of snapshot.tables) {
            sourceTableExtIds.add(srcTable.externalId)
            const matched = destTableMap.get(srcTable.externalId)
            if (!matched) {
                creates.push({
                    kind: 'table',
                    externalId: srcTable.externalId,
                    op: 'CREATE',
                    name: srcTable.name,
                    description: `Create table "${srcTable.name}"`,
                })
            }
            else {
                const destFields: Field[] = await fieldService.getAll({ projectId: targetProjectId, tableId: matched.id })
                const normSrcFields = (srcTable.fields || []).map((f) => ({ name: f.name, type: f.type, externalId: f.externalId })).sort((a, b) => (a.externalId || '').localeCompare(b.externalId || ''))
                const normDestFields = destFields.map((f) => ({ name: f.name, type: f.type, externalId: f.externalId })).sort((a, b) => (a.externalId || '').localeCompare(b.externalId || ''))

                const hasChanges = matched.name !== srcTable.name
                    || matched.status !== (srcTable.status ?? null)
                    || matched.trigger !== (srcTable.trigger ?? null)
                    || canonicalJson(normSrcFields) !== canonicalJson(normDestFields)
                if (hasChanges) {
                    updates.push({
                        kind: 'table',
                        externalId: srcTable.externalId,
                        op: 'UPDATE',
                        name: srcTable.name,
                        description: `Update table "${srcTable.name}"`,
                        changes: {
                            oldName: matched.name,
                            newName: srcTable.name,
                        },
                    })
                }
                else {
                    unchanged.push({ kind: 'table', externalId: srcTable.externalId })
                }
            }
        }

        for (const [destExtId, destTable] of destTableMap.entries()) {
            if (!sourceTableExtIds.has(destExtId)) {
                deletes.push({
                    kind: 'table',
                    externalId: destExtId,
                    op: 'DELETE',
                    name: destTable.name,
                    description: `Delete table "${destTable.name}"`,
                })
            }
        }

        // Agents Diff
        const destAgents = await agentRepo().find({ where: { projectId: targetProjectId } })
        const destAgentMap = new Map<string, typeof destAgents[0]>()
        for (const da of destAgents) {
            destAgentMap.set(da.externalId, da)
        }

        const sourceAgentExtIds = new Set<string>()
        for (const srcAgent of effectiveAgents) {
            sourceAgentExtIds.add(srcAgent.externalId)
            const matched = destAgentMap.get(srcAgent.externalId)

            const rawProvider = srcAgent.model.provider
            const targetProvider = providerMap.get(rawProvider.toLowerCase()) ?? rawProvider

            if (!matched) {
                creates.push({
                    kind: 'agent',
                    externalId: srcAgent.externalId,
                    op: 'CREATE',
                    name: srcAgent.displayName,
                    description: `Create agent "${srcAgent.displayName}" (${srcAgent.externalId})`,
                })
            }
            else {
                const modelChanged = matched.model.provider !== targetProvider || matched.model.model !== srcAgent.model.model
                const basicChanged = matched.displayName !== srcAgent.displayName
                    || (matched.description ?? null) !== (srcAgent.description ?? null)
                    || matched.prompt !== srcAgent.prompt
                    || matched.maxSteps !== (srcAgent.maxSteps ?? 10)
                    || matched.status !== (srcAgent.status ?? 'ENABLED')
                    || canonicalJson(matched.structuredOutput ?? null) !== canonicalJson(srcAgent.structuredOutput ?? null)

                const normalizedSrcTools = normalizeToolsForComparison(srcAgent.tools, connectionMappings)
                const normalizedDestTools = normalizeToolsForComparison(matched.tools)
                const toolsChanged = canonicalJson(normalizedSrcTools) !== canonicalJson(normalizedDestTools)

                if (modelChanged || basicChanged || toolsChanged) {
                    updates.push({
                        kind: 'agent',
                        externalId: srcAgent.externalId,
                        op: 'UPDATE',
                        name: srcAgent.displayName,
                        description: `Update agent "${srcAgent.displayName}" (${srcAgent.externalId})`,
                        changes: {
                            ...(modelChanged && { model: { from: matched.model, to: { provider: targetProvider, model: srcAgent.model.model } } }),
                            ...(basicChanged && { basicChanged: true }),
                            ...(toolsChanged && { toolsChanged: true }),
                        },
                    })
                }
                else {
                    unchanged.push({ kind: 'agent', externalId: srcAgent.externalId })
                }
            }
        }

        for (const [destExtId, destAgent] of destAgentMap.entries()) {
            if (!sourceAgentExtIds.has(destExtId)) {
                deletes.push({
                    kind: 'agent',
                    externalId: destExtId,
                    op: 'DELETE',
                    name: destAgent.displayName,
                    description: `Delete agent "${destAgent.displayName}" (${destExtId})`,
                })
            }
        }

        // Trigger Bindings Diff — use snapshot externalId for collision-free identity
        const destTriggerBindings = await triggerBindingRepo().find({ where: { projectId: targetProjectId } })
        const destTbMap = new Map<string, typeof destTriggerBindings[0]>()
        for (const dtb of destTriggerBindings) {
            const key = dtb.id
            destTbMap.set(key, dtb)
        }

        const sourceTbKeys = new Set<string>()
        for (const srcTb of snapshot.triggerBindings) {
            const key = srcTb.externalId ?? `${srcTb.pieceName}::${srcTb.triggerName}`
            sourceTbKeys.add(key)
            // Match either by externalId (id) or by (pieceName + triggerName)
            const matched = destTbMap.get(key) || Array.from(destTbMap.values()).find((dtb) => dtb.pieceName === srcTb.pieceName && dtb.triggerName === srcTb.triggerName)
            if (!matched) {
                creates.push({
                    kind: 'trigger_binding',
                    externalId: key,
                    op: 'CREATE',
                    name: `${srcTb.pieceName} (${srcTb.triggerName})`,
                    description: `Create trigger binding for ${srcTb.pieceName} (${srcTb.triggerName})`,
                })
            }
            else {
                let connectionChanged = false
                if (srcTb.connectionExternalId) {
                    const mappedConn = connectionsReport.mapped.find((m) => m.sourceExternalId === srcTb.connectionExternalId)
                    if (mappedConn) {
                        if (mappedConn.mappingType === 'BOOTSTRAP') {
                            if (!mappedConn.destConnectionId || mappedConn.destConnectionId !== matched.connectionId) {
                                connectionChanged = true
                            }
                        }
                        else if (mappedConn.destConnectionId && mappedConn.destConnectionId !== matched.connectionId) {
                            connectionChanged = true
                        }
                    }
                }

                const hasChanges = matched.promptTemplate !== srcTb.promptTemplate
                    || matched.status !== srcTb.status
                    || canonicalJson(matched.settings) !== canonicalJson(srcTb.settings)
                    || canonicalJson(matched.propertySettings ?? null) !== canonicalJson(srcTb.propertySettings ?? null)
                    || connectionChanged
                if (hasChanges) {
                    updates.push({
                        kind: 'trigger_binding',
                        externalId: matched.id,
                        op: 'UPDATE',
                        name: `${srcTb.pieceName} (${srcTb.triggerName})`,
                        description: `Update trigger binding for ${srcTb.pieceName} (${srcTb.triggerName})`,
                    })
                }
                else {
                    unchanged.push({ kind: 'trigger_binding', externalId: matched.id })
                }
            }
        }

        for (const [key, dtb] of destTbMap.entries()) {
            const matchedInSource = snapshot.triggerBindings.some((b) => (b.externalId && b.externalId === key) || (b.pieceName === dtb.pieceName && b.triggerName === dtb.triggerName))
            if (!matchedInSource) {
                deletes.push({
                    kind: 'trigger_binding',
                    externalId: key,
                    op: 'DELETE',
                    name: `${dtb.pieceName} (${dtb.triggerName})`,
                    description: `Delete trigger binding for ${dtb.pieceName} (${dtb.triggerName})`,
                })
            }
        }

        // Scheduled Tasks Diff
        const destScheduledTasks = await scheduledTaskRepo().find({ where: { projectId: targetProjectId } })
        const destStMap = new Map<string, typeof destScheduledTasks[0]>()
        for (const dst of destScheduledTasks) {
            const key = dst.id
            destStMap.set(key, dst)
        }

        for (const srcSt of snapshot.scheduledTasks) {
            const key = srcSt.externalId ?? `${srcSt.prompt}::${srcSt.cronExpression}`
            const matched = destStMap.get(key) || Array.from(destStMap.values()).find((dst) => dst.prompt === srcSt.prompt && dst.cronExpression === srcSt.cronExpression)
            if (!matched) {
                creates.push({
                    kind: 'scheduled_task',
                    externalId: key,
                    op: 'CREATE',
                    name: srcSt.prompt,
                    description: `Create scheduled task: "${srcSt.prompt.slice(0, 30)}" (${srcSt.cronExpression})`,
                })
            }
            else {
                const hasChanges = matched.timezone !== srcSt.timezone || matched.status !== srcSt.status
                if (hasChanges) {
                    updates.push({
                        kind: 'scheduled_task',
                        externalId: matched.id,
                        op: 'UPDATE',
                        name: srcSt.prompt,
                        description: `Update scheduled task: "${srcSt.prompt.slice(0, 30)}" (${srcSt.cronExpression})`,
                    })
                }
                else {
                    unchanged.push({ kind: 'scheduled_task', externalId: matched.id })
                }
            }
        }

        for (const [key, dst] of destStMap.entries()) {
            const matchedInSource = snapshot.scheduledTasks.some((s) => (s.externalId && s.externalId === key) || (s.prompt === dst.prompt && s.cronExpression === dst.cronExpression))
            if (!matchedInSource) {
                deletes.push({
                    kind: 'scheduled_task',
                    externalId: key,
                    op: 'DELETE',
                    name: dst.prompt,
                    description: `Delete scheduled task: "${dst.prompt.slice(0, 30)}" (${dst.cronExpression})`,
                })
            }
        }

        // MCP Diff
        const destMcp = await mcpServerRepository().findOneBy({ projectId: targetProjectId })
        const sourceDisabledTools = [...(snapshot.mcp?.disabledTools ?? [])].sort()
        const destDisabledTools = [...(destMcp?.disabledTools ?? [])].sort()
        const mcpExternalId = snapshot.mcp?.externalId ?? 'default'

        if (snapshot.mcp === null) {
            if (destMcp) {
                deletes.push({
                    kind: 'mcp_server',
                    externalId: mcpExternalId,
                    op: 'DELETE',
                    name: 'mcp_server',
                    description: 'Delete MCP server configuration on destination',
                })
            }
            else {
                unchanged.push({ kind: 'mcp_server', externalId: mcpExternalId })
            }
        }
        else if (!destMcp) {
            creates.push({
                kind: 'mcp_server',
                externalId: mcpExternalId,
                op: 'CREATE',
                name: 'mcp_server',
                description: 'Create MCP server configuration on destination',
            })
        }
        else if (canonicalJson(sourceDisabledTools) !== canonicalJson(destDisabledTools)) {
            updates.push({
                kind: 'mcp_server',
                externalId: mcpExternalId,
                op: 'UPDATE',
                name: 'mcp_server',
                description: 'Update MCP server disabled tools configuration',
                changes: {
                    oldDisabledTools: destDisabledTools,
                    newDisabledTools: sourceDisabledTools,
                },
            })
        }
        else {
            unchanged.push({ kind: 'mcp_server', externalId: mcpExternalId })
        }

        // Dependency Ordering: ensure dependencies are created before dependents, and deletes happen in reverse
        const sortDiffDeterministic = (a: ProjectReplaceDiffItem, b: ProjectReplaceDiffItem): number =>
            `${a.kind}:${a.op}:${a.externalId}`.localeCompare(`${b.kind}:${b.op}:${b.externalId}`)
        creates.sort((a, b) => (RESOURCE_CREATE_ORDER[a.kind] - RESOURCE_CREATE_ORDER[b.kind]) || sortDiffDeterministic(a, b))
        updates.sort((a, b) => (RESOURCE_CREATE_ORDER[a.kind] - RESOURCE_CREATE_ORDER[b.kind]) || sortDiffDeterministic(a, b))
        deletes.sort((a, b) => (RESOURCE_DELETE_ORDER[a.kind] - RESOURCE_DELETE_ORDER[b.kind]) || sortDiffDeterministic(a, b))
        unchanged.sort((a, b) => `${a.kind}:${a.externalId}`.localeCompare(`${b.kind}:${b.externalId}`))

        // 6. Checksum and Plan Signature
        const planId = apId()
        const checksum = computeSha256(canonicalJson(snapshot))
        const unsignedPlan: Omit<ProjectReplacePlan, 'signature'> = {
            planId,
            schemaVersion: 1,
            toolVersion: currentVersion,
            createdAt: new Date().toISOString(),
            sourceActivepiecesVersion: snapshot.sourceActivepiecesVersion,
            targetActivepiecesVersion: currentVersion,
            targetProjectId,
            checksum,
            destinationStateHash,
            preflight: {
                passed: preflightErrors.length === 0,
                errors: preflightErrors,
                warnings: preflightWarnings,
                customIntegrations,
                connections: connectionsReport,
            },
            connectionMappings: (connectionMappings ?? []).map(sanitizeMappingForPlan),
            providerMappings: (providerMappings ?? []).map((pm: ProviderMappingSchema) => ({
                sourceProvider: pm.sourceProvider,
                destProvider: pm.destProvider,
            })),
            changes: {
                creates,
                updates,
                deletes,
                unchanged,
            },
            summary: {
                created: creates.length,
                updated: updates.length,
                deleted: deletes.length,
                unchanged: unchanged.length,
            },
        }

        const signature = computePlanSignature(unsignedPlan)

        return {
            ...unsignedPlan,
            signature,
        }
    },

    async applyPlan({
        targetProjectId,
        targetPlatformId,
        request,
        snapshot,
    }: {
        targetProjectId: string
        targetPlatformId: string
        request: ProjectReplaceApplyRequest
        snapshot: ProjectStateSnapshot
    }): Promise<ProjectReplaceApplyResult> {
        const plan = request.plan

        // 1. Target project ID verification (prevent cross-project replay)
        if (plan.targetProjectId !== targetProjectId) {
            const err = new Error(`Cross-project replacement rejected. Plan was created for project "${plan.targetProjectId}", cannot apply to "${targetProjectId}".`) as Error & { statusCode: number }
            err.statusCode = StatusCodes.FORBIDDEN
            throw err
        }

        // 2. Recompute checksum from submitted snapshot (assert snapshot binding)
        const recomputedChecksum = computeSha256(canonicalJson(snapshot))
        if (recomputedChecksum !== plan.checksum) {
            const err = new Error('Submitted snapshot checksum does not match plan checksum. Swapped or modified snapshot detected.') as Error & { statusCode: number }
            err.statusCode = StatusCodes.BAD_REQUEST
            throw err
        }

        // 3. Signature verification (full canonical plan coverage)
        const unsignedPlan: Omit<ProjectReplacePlan, 'signature'> = {
            planId: plan.planId,
            schemaVersion: plan.schemaVersion,
            toolVersion: plan.toolVersion,
            createdAt: plan.createdAt,
            sourceActivepiecesVersion: plan.sourceActivepiecesVersion,
            targetActivepiecesVersion: plan.targetActivepiecesVersion,
            targetProjectId: plan.targetProjectId,
            checksum: plan.checksum,
            destinationStateHash: plan.destinationStateHash,
            preflight: plan.preflight,
            connectionMappings: plan.connectionMappings,
            providerMappings: plan.providerMappings,
            changes: plan.changes,
            summary: plan.summary,
        }
        const expectedSignature = computePlanSignature(unsignedPlan)
        const expectedSigBuf = Buffer.from(expectedSignature, 'hex')
        const sigBuf = Buffer.from(plan.signature || '', 'hex')
        const validSignature = sigBuf.length === expectedSigBuf.length && crypto.timingSafeEqual(sigBuf, expectedSigBuf)
        if (!validSignature) {
            const err = new Error('Plan signature verification failed. Plan artifact has been tampered with or corrupted.') as Error & { statusCode: number }
            err.statusCode = StatusCodes.BAD_REQUEST
            throw err
        }

        // 3.5 Assert connection mappings binding to signed plan
        const sanitizedPlanMappings = (plan.connectionMappings ?? []).map(sanitizeMappingForPlan).sort((a, b) => a.sourceExternalId.localeCompare(b.sourceExternalId))
        const sanitizedReqMappings = (request.connectionMappings ?? []).map(sanitizeMappingForPlan).sort((a, b) => a.sourceExternalId.localeCompare(b.sourceExternalId))

        if (canonicalJson(sanitizedPlanMappings) !== canonicalJson(sanitizedReqMappings)) {
            const err = new Error('Connection mappings supplied at apply time do not match the signed plan. Mapping substitution or tampering detected.') as Error & { statusCode: number }
            err.statusCode = StatusCodes.BAD_REQUEST
            throw err
        }

        // 4. Preflight verification (--force only waives preflight warnings, NEVER drift; inspectOnly bypasses mutation block)
        if (!plan.preflight.passed && !request.force && !request.inspectOnly) {
            const err = new Error(`Preflight checks failed: ${plan.preflight.errors.map((e) => e.message).join('; ')}`) as Error & { statusCode: number }
            err.statusCode = StatusCodes.BAD_REQUEST
            throw err
        }

        // 5. Wrap drift verification and mutations in distributedLock to avoid races
        return distributedLock(system.globalLogger()).runExclusive({
            key: `project_replace_lock_${targetProjectId}`,
            timeoutInSeconds: 60,
            fn: async () => {
                const startTime = Date.now()

                // Destination Drift Detection (strictly enforced; --force does not waive drift)
                const currentDestinationHash = await this.computeDestinationStateHash(targetProjectId, targetPlatformId)
                if (currentDestinationHash !== plan.destinationStateHash) {
                    const err = new Error('Destination project state has drifted since the plan was created. Re-run plan or recreate plan artifact.') as Error & { statusCode: number }
                    err.statusCode = StatusCodes.CONFLICT
                    throw err
                }

                const applied = {
                    tablesCreated: 0,
                    tablesUpdated: 0,
                    tablesDeleted: 0,
                    tablesUnchanged: 0,
                    agentsCreated: 0,
                    agentsUpdated: 0,
                    agentsDeleted: 0,
                    agentsUnchanged: 0,
                    triggerBindingsCreated: 0,
                    triggerBindingsUpdated: 0,
                    triggerBindingsDeleted: 0,
                    triggerBindingsUnchanged: 0,
                    scheduledTasksCreated: 0,
                    scheduledTasksUpdated: 0,
                    scheduledTasksDeleted: 0,
                    scheduledTasksUnchanged: 0,
                    mcpCreated: 0,
                    mcpUpdated: 0,
                    mcpDeleted: 0,
                    mcpUnchanged: 0,
                    customPiecesInstalled: 0,
                    customPiecesUnchanged: 0,
                    connectionsCreated: 0,
                    connectionsUpdated: 0,
                    connectionsUnchanged: 0,
                }
                const failed: Array<{ kind: ProjectReplaceResourceKind, externalId: string, op: ProjectReplaceOp, error: string }> = []

                if (request.dryRun || request.inspectOnly) {
                    return {
                        applied,
                        failed,
                        durationMs: Date.now() - startTime,
                    }
                }

                // Phase 0: Custom Piece Deployment (Ordered BEFORE Trigger Bindings & Mutations!)
                const failedCustomPieceNames = new Set<string>()

                // Any custom pieces that were missing from snapshot or failed preflight must also block dependent activation under --force
                for (const err of plan.preflight.errors) {
                    if (err.kind === 'MISSING_CUSTOM_PIECE' || err.kind === 'MISSING_PIECE' || err.kind === 'CHECKSUM_MISMATCH' || err.kind === 'INCOMPATIBLE_INTEGRATION') {
                        const pieceName = (err.details?.pieceName as string) || (err.message.match(/piece\s+([^\s@]+)/i)?.[1])
                        if (pieceName) {
                            failedCustomPieceNames.add(pieceName)
                        }
                    }
                }

                if (request.deployCustomIntegrations === true) {
                    for (const change of plan.changes.creates.filter((c) => c.kind === 'custom_piece')) {
                        const lastSep = change.externalId.lastIndexOf('::')
                        const pieceName = lastSep !== -1 ? change.externalId.slice(0, lastSep) : change.externalId
                        const pieceVersion = lastSep !== -1 ? change.externalId.slice(lastSep + 2) : ''
                        const pieceInfo = snapshot.requiredPieces.find((p) => p.name === pieceName && p.version === pieceVersion)
                            ?? snapshot.customPieces?.find((p) => p.name === pieceName && p.version === pieceVersion)

                        if (!pieceInfo?.archiveFileBase64) {
                            failed.push({
                                kind: 'custom_piece',
                                externalId: change.externalId,
                                op: 'CREATE',
                                error: 'Missing package archive data for deployment',
                            })
                            failedCustomPieceNames.add(pieceName)
                            continue
                        }

                        try {
                            // Check if already installed on destination (idempotency) and verify compatibility/integrity
                            const existing = await pieceMetadataService(log).get({
                                name: pieceName,
                                version: pieceVersion,
                                platformId: targetPlatformId,
                            })
                            if (existing) {
                                applied.customPiecesUnchanged++
                                continue
                            }

                            // Platform safety gate: verify piece is not filtered or blocked by platform policy
                            const isFiltered = await pieceFilteringHooks.get(log).isFiltered({
                                piece: { name: pieceName, version: pieceVersion } as unknown as PieceMetadataSchema,
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                            })
                            if (isFiltered) {
                                failed.push({
                                    kind: 'custom_piece',
                                    externalId: change.externalId,
                                    op: 'CREATE',
                                    error: `Installation blocked: custom integration "${pieceName}" is blocked by platform policy`,
                                })
                                failedCustomPieceNames.add(pieceName)
                                continue
                            }

                            // Strict package integrity check
                            if (!pieceInfo.archiveChecksum) {
                                throw new Error(`Integrity checksum missing for custom piece "${pieceName}"`)
                            }
                            const archiveBuf = Buffer.from(pieceInfo.archiveFileBase64, 'base64')
                            const checksum = crypto.createHash('sha256').update(archiveBuf).digest('hex')
                            if (checksum !== pieceInfo.archiveChecksum) {
                                throw new Error(`Integrity checksum mismatch for custom piece "${pieceName}": expected ${pieceInfo.archiveChecksum}, got ${checksum}`)
                            }

                            // Sanitize filename: replace all slashes, colons, or invalid chars
                            const safePieceFileName = pieceName.replace(/[@/\\:]/g, '-')
                            const safeVersion = pieceVersion.replace(/[/\\:]/g, '-')

                            // Verify platform piece safety gate before installation
                            const isBlocked = await pieceFilteringHooks.get(log).isFiltered({
                                piece: { name: pieceName, version: pieceVersion } as unknown as PieceMetadataSchema,
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                            })
                            if (isBlocked) {
                                throw new Error(`Custom piece "${pieceName}" is blocked by platform safety policy`)
                            }

                            // Install scoped strictly to targetPlatformId (tenant isolation)
                            await pieceInstallService(log).installPiece(targetPlatformId, {
                                packageType: PackageType.ARCHIVE,
                                scope: PieceScope.PLATFORM,
                                pieceName,
                                pieceVersion,
                                pieceArchive: {
                                    filename: `${safePieceFileName}-${safeVersion}.tgz`,
                                    data: archiveBuf,
                                    type: 'file',
                                } as ApMultipartFile,
                            })
                            applied.customPiecesInstalled++
                        }
                        catch (err) {
                            failed.push({
                                kind: 'custom_piece',
                                externalId: change.externalId,
                                op: 'CREATE',
                                error: getErrorMessage(err),
                            })
                            failedCustomPieceNames.add(pieceName)
                        }
                    }
                    applied.customPiecesUnchanged += plan.changes.unchanged.filter((u) => u.kind === 'custom_piece').length
                }
                else {
                    // When deployment is not enabled, record deployable custom pieces as failed so dependencies know they are unavailable
                    for (const change of plan.changes.creates.filter((c) => c.kind === 'custom_piece')) {
                        const lastSep = change.externalId.lastIndexOf('::')
                        const pieceName = lastSep !== -1 ? change.externalId.slice(0, lastSep) : change.externalId
                        failedCustomPieceNames.add(pieceName)
                    }
                }

                // Phase 0.5: Connection Bootstrap & Resolution (BEFORE Table & Trigger Mutations!)
                const resolvedConnections = new Map<string, string>() // sourceExternalId -> destConnectionId
                const failedConnectionExternalIds = new Set<string>()

                // 1. Process connectionMappings if provided
                const effectiveMappings = request.connectionMappings ?? plan.connectionMappings ?? []
                for (const mapping of effectiveMappings) {
                    if (mapping.value) {
                        // Bootstrap credentials
                        const destExtId = mapping.destExternalId ?? mapping.sourceExternalId
                        const pieceName = mapping.pieceName
                            ?? snapshot.requiredConnections.find((c) => c.externalId === mapping.sourceExternalId)?.pieceName

                        if (!pieceName) {
                            failed.push({
                                kind: 'connection',
                                externalId: destExtId,
                                op: 'CREATE',
                                error: `Missing pieceName for connection bootstrap (${destExtId})`,
                            })
                            failedConnectionExternalIds.add(mapping.sourceExternalId)
                            continue
                        }

                        try {
                            const existing = await connectionRepo().findOne({
                                where: {
                                    externalId: destExtId,
                                    platformId: targetPlatformId,
                                    projectIds: ArrayContains([targetProjectId]),
                                },
                            })
                            if (existing && existing.pieceName !== pieceName) {
                                throw new Error(`Incompatible connection: existing "${destExtId}" has piece "${existing.pieceName}", cannot bootstrap as "${pieceName}"`)
                            }

                            let pieceVersion = '0.0.1'
                            try {
                                const meta = await pieceMetadataService(log).get({
                                    name: pieceName,
                                    platformId: targetPlatformId,
                                })
                                if (meta?.version) {
                                    pieceVersion = meta.version
                                }
                            }
                            catch {
                                // default fallback
                            }

                            const connType = mapping.type
                                ?? (mapping.value.type as AppConnectionType)
                                ?? AppConnectionType.SECRET_TEXT

                            let connValue: AppConnectionValue
                            if (connType === AppConnectionType.SECRET_TEXT) {
                                const secretText = mapping.value.secret_text ?? mapping.value.apiKey ?? mapping.value.token ?? mapping.value.secret
                                if (!secretText) {
                                    throw new Error(`Missing secret text for connection bootstrap "${destExtId}"`)
                                }
                                connValue = {
                                    type: AppConnectionType.SECRET_TEXT,
                                    secret_text: String(secretText),
                                }
                            }
                            else if (connType === AppConnectionType.CUSTOM_AUTH) {
                                const props = mapping.value.props ?? mapping.value
                                if (!props || typeof props !== 'object') {
                                    throw new Error(`Invalid custom auth properties for connection bootstrap "${destExtId}"`)
                                }
                                connValue = {
                                    type: AppConnectionType.CUSTOM_AUTH,
                                    props: props as Record<string, unknown>,
                                }
                            }
                            else if (connType === AppConnectionType.BASIC_AUTH) {
                                if (!mapping.value.username || !mapping.value.password) {
                                    throw new Error(`Missing username or password for basic auth connection bootstrap "${destExtId}"`)
                                }
                                connValue = {
                                    type: AppConnectionType.BASIC_AUTH,
                                    username: String(mapping.value.username),
                                    password: String(mapping.value.password),
                                }
                            }
                            else {
                                connValue = {
                                    type: connType,
                                    ...mapping.value,
                                } as unknown as AppConnectionValue
                            }

                            const created = await appConnectionService(log).upsert({
                                projectIds: [targetProjectId],
                                platformId: targetPlatformId,
                                externalId: destExtId,
                                displayName: mapping.displayName ?? existing?.displayName ?? destExtId,
                                pieceName,
                                pieceVersion,
                                type: connType,
                                value: connValue as Parameters<ReturnType<typeof appConnectionService>['upsert']>[0]['value'],
                                scope: AppConnectionScope.PROJECT,
                                ownerId: null,
                            })
                            if (existing) {
                                applied.connectionsUpdated++
                            }
                            else {
                                applied.connectionsCreated++
                            }
                            resolvedConnections.set(mapping.sourceExternalId, created.id)
                        }
                        catch (err) {
                            failed.push({
                                kind: 'connection',
                                externalId: destExtId,
                                op: 'CREATE',
                                error: getErrorMessage(err),
                            })
                            failedConnectionExternalIds.add(mapping.sourceExternalId)
                        }
                    }
                    else {
                        // Remap to existing destination connection
                        try {
                            const targetRef = mapping.destExternalId ?? mapping.destConnectionId ?? 'unknown'
                            const targetLookup = mapping.destExternalId
                                ? await connectionRepo().findOne({
                                    where: {
                                        externalId: mapping.destExternalId,
                                        platformId: targetPlatformId,
                                        projectIds: ArrayContains([targetProjectId]),
                                    },
                                })
                                : mapping.destConnectionId
                                    ? await connectionRepo().findOne({
                                        where: {
                                            id: mapping.destConnectionId,
                                            platformId: targetPlatformId,
                                            projectIds: ArrayContains([targetProjectId]),
                                        },
                                    })
                                    : null

                            if (!targetLookup) {
                                failed.push({
                                    kind: 'connection',
                                    externalId: mapping.sourceExternalId,
                                    op: 'UPDATE',
                                    error: `Mapped destination connection "${targetRef}" not found`,
                                })
                                failedConnectionExternalIds.add(mapping.sourceExternalId)
                            }
                            else {
                                const expectedPiece = mapping.pieceName ?? snapshot.requiredConnections.find((c) => c.externalId === mapping.sourceExternalId)?.pieceName
                                if (expectedPiece && targetLookup.pieceName !== expectedPiece) {
                                    throw new Error(`Incompatible connection: mapped destination "${targetRef}" belongs to piece "${targetLookup.pieceName}", but binding requires "${expectedPiece}"`)
                                }
                                resolvedConnections.set(mapping.sourceExternalId, targetLookup.id)
                                applied.connectionsUnchanged++
                            }
                        }
                        catch (err) {
                            failed.push({
                                kind: 'connection',
                                externalId: mapping.sourceExternalId,
                                op: 'UPDATE',
                                error: getErrorMessage(err),
                            })
                            failedConnectionExternalIds.add(mapping.sourceExternalId)
                        }
                    }
                }

                // 2. Resolve any remaining required connections directly on destination
                for (const reqConn of snapshot.requiredConnections) {
                    if (!resolvedConnections.has(reqConn.externalId) && !failedConnectionExternalIds.has(reqConn.externalId)) {
                        const destConn = await connectionRepo().findOne({
                            where: {
                                externalId: reqConn.externalId,
                                platformId: targetPlatformId,
                                projectIds: ArrayContains([targetProjectId]),
                            },
                        })
                        if (!destConn) {
                            failed.push({
                                kind: 'connection',
                                externalId: reqConn.externalId,
                                op: 'UPDATE',
                                error: `Required connection "${reqConn.externalId}" (${reqConn.pieceName}) not found on destination`,
                            })
                            failedConnectionExternalIds.add(reqConn.externalId)
                        }
                        else if (destConn.pieceName !== reqConn.pieceName) {
                            failed.push({
                                kind: 'connection',
                                externalId: reqConn.externalId,
                                op: 'UPDATE',
                                error: `Incompatible connection: destination connection "${reqConn.externalId}" has piece "${destConn.pieceName}", expected "${reqConn.pieceName}"`,
                            })
                            failedConnectionExternalIds.add(reqConn.externalId)
                        }
                        else {
                            resolvedConnections.set(reqConn.externalId, destConn.id)
                            applied.connectionsUnchanged++
                        }
                    }
                }

                // Phase 1: Tables CREATE / UPDATE
                for (const change of plan.changes.creates.filter((c) => c.kind === 'table')) {
                    try {
                        const srcTable = snapshot.tables.find((t) => t.externalId === change.externalId)
                        if (srcTable) {
                            const newTable = await tableService.create({
                                projectId: targetProjectId,
                                request: {
                                    projectId: targetProjectId,
                                    name: srcTable.name,
                                    externalId: srcTable.externalId,
                                    fields: srcTable.fields?.map((f) => ({
                                        name: f.name,
                                        type: f.type as FieldType,
                                        externalId: f.externalId,
                                    })),
                                },
                            })
                            if (srcTable.status !== undefined || srcTable.trigger !== undefined) {
                                await tableRepo().update({ id: newTable.id }, {
                                    status: (srcTable.status ?? null) as TableAutomationStatus,
                                    trigger: (srcTable.trigger ?? null) as TableAutomationTrigger,
                                })
                            }
                            applied.tablesCreated++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'table', externalId: change.externalId, op: 'CREATE', error: getErrorMessage(err) })
                    }
                }

                for (const change of plan.changes.updates.filter((c) => c.kind === 'table')) {
                    try {
                        const srcTable = snapshot.tables.find((t) => t.externalId === change.externalId)
                        if (srcTable) {
                            const destTable = await tableRepo().findOneBy({ projectId: targetProjectId, externalId: change.externalId })
                            if (!destTable) {
                                failed.push({ kind: 'table', externalId: change.externalId, op: 'UPDATE', error: `Table ${change.externalId} not found on destination` })
                                continue
                            }

                            const updatePayload: { name: string, status?: TableAutomationStatus | null, trigger?: TableAutomationTrigger | null } = {
                                name: srcTable.name,
                            }
                            if ('status' in srcTable) {
                                updatePayload.status = (srcTable.status as TableAutomationStatus) ?? null
                            }
                            if ('trigger' in srcTable) {
                                updatePayload.trigger = (srcTable.trigger as TableAutomationTrigger) ?? null
                            }
                            await tableRepo().update({ id: destTable.id }, updatePayload)

                            if (srcTable.fields) {
                                const currentFields: Field[] = await fieldService.getAll({ projectId: targetProjectId, tableId: destTable.id })
                                const matchedFieldIds = new Set<string>()
                                for (const sf of srcTable.fields) {
                                    const matchField = currentFields.find((cf) => (sf.externalId && cf.externalId === sf.externalId) || cf.name === sf.name)
                                    if (!matchField) {
                                        await fieldService.create({
                                            projectId: targetProjectId,
                                            request: {
                                                tableId: destTable.id,
                                                name: sf.name,
                                                type: sf.type as FieldType,
                                                externalId: sf.externalId,
                                            } as unknown as CreateFieldRequest,
                                        })
                                    }
                                    else {
                                        matchedFieldIds.add(matchField.id)
                                        if (matchField.type !== sf.type) {
                                            await fieldService.delete({ id: matchField.id, projectId: targetProjectId })
                                            await fieldService.create({
                                                projectId: targetProjectId,
                                                request: {
                                                    tableId: destTable.id,
                                                    name: sf.name,
                                                    type: sf.type as FieldType,
                                                    externalId: sf.externalId,
                                                } as unknown as CreateFieldRequest,
                                            })
                                        }
                                        else if (matchField.name !== sf.name) {
                                            await fieldService.update({
                                                id: matchField.id,
                                                projectId: targetProjectId,
                                                request: {
                                                    name: sf.name,
                                                },
                                            })
                                        }
                                    }
                                }
                                for (const cf of currentFields) {
                                    if (!matchedFieldIds.has(cf.id)) {
                                        await fieldService.delete({ id: cf.id, projectId: targetProjectId })
                                    }
                                }
                            }
                            applied.tablesUpdated++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'table', externalId: change.externalId, op: 'UPDATE', error: getErrorMessage(err) })
                    }
                }

                applied.tablesUnchanged = plan.changes.unchanged.filter((u) => u.kind === 'table').length

                // Phase 1.5: Agents CREATE / UPDATE (Dependencies: Tables, Connections, and Custom Pieces exist; Dependents: Trigger Bindings, Tasks)
                const providerMap = new Map<string, string>()
                if (request.providerMappings) {
                    for (const pm of request.providerMappings) {
                        providerMap.set(pm.sourceProvider.toLowerCase(), pm.destProvider)
                    }
                }

                // Provider remaps used to be dropped from the artifact, so an apply driven by
                // `--plan-file` had no way to know a remap was ever requested and fell through
                // to `?? rawProvider` - silently writing destination agents against the SOURCE
                // provider and reporting success (#502). They are now signed into the plan, so
                // this map is authoritative and cannot be edited without breaking the HMAC.
                const planProviderMap = new Map<string, string>()
                for (const pm of plan.providerMappings ?? []) {
                    planProviderMap.set(pm.sourceProvider.toLowerCase(), pm.destProvider)
                }

                // Request-time mappings override the artifact, so an operator can still change
                // the destination at apply time. The artifact is the fallback. Falling through
                // to the raw provider is correct here: it means nothing ever remapped that
                // provider, which is the common case and must keep applying unchanged.
                const resolveTargetProvider = (rawProvider: string): string => {
                    const key = rawProvider.toLowerCase()
                    return providerMap.get(key) ?? planProviderMap.get(key) ?? rawProvider
                }

                const effectiveAgents: AgentSnapshotSchema[] = [...(snapshot.agents ?? [])]
                if (snapshot.flows && snapshot.flows.length > 0) {
                    const flowAgents = extractAgentsFromFlows(snapshot.flows)
                    for (const fa of flowAgents) {
                        if (!effectiveAgents.some((a) => a.externalId === fa.externalId)) {
                            effectiveAgents.push(fa)
                        }
                    }
                }

                for (const change of plan.changes.creates.filter((c) => c.kind === 'agent')) {
                    try {
                        const srcAgent = effectiveAgents.find((a) => a.externalId === change.externalId)
                        if (srcAgent) {
                            const rawProvider = srcAgent.model.provider
                            const targetProvider = resolveTargetProvider(rawProvider)

                            const mappedTools = remapAgentTools(srcAgent.tools, resolvedConnections, request.connectionMappings)

                            await agentService.create({
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                                externalId: srcAgent.externalId,
                                displayName: srcAgent.displayName,
                                description: srcAgent.description ?? null,
                                prompt: srcAgent.prompt,
                                maxSteps: srcAgent.maxSteps ?? 10,
                                model: {
                                    provider: targetProvider,
                                    model: srcAgent.model.model,
                                },
                                tools: mappedTools,
                                structuredOutput: srcAgent.structuredOutput ?? null,
                                status: srcAgent.status ?? 'ENABLED',
                            })
                            applied.agentsCreated++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'agent', externalId: change.externalId, op: 'CREATE', error: getErrorMessage(err) })
                    }
                }

                for (const change of plan.changes.updates.filter((c) => c.kind === 'agent')) {
                    try {
                        const srcAgent = effectiveAgents.find((a) => a.externalId === change.externalId)
                        if (!srcAgent) continue

                        const existing = await agentRepo().findOneBy({ projectId: targetProjectId, externalId: change.externalId })
                        if (!existing) {
                            throw new Error(`Destination agent with externalId "${change.externalId}" not found for update`)
                        }

                        const rawProvider = srcAgent.model.provider
                        const targetProvider = resolveTargetProvider(rawProvider)

                        const mappedTools = remapAgentTools(srcAgent.tools, resolvedConnections, request.connectionMappings, existing.tools)

                        await agentService.update({
                            id: existing.id,
                            projectId: targetProjectId,
                            platformId: targetPlatformId,
                            displayName: srcAgent.displayName,
                            description: srcAgent.description ?? null,
                            prompt: srcAgent.prompt,
                            maxSteps: srcAgent.maxSteps ?? 10,
                            model: {
                                provider: targetProvider,
                                model: srcAgent.model.model,
                            },
                            tools: mappedTools,
                            structuredOutput: srcAgent.structuredOutput ?? null,
                            status: srcAgent.status ?? 'ENABLED',
                        })
                        applied.agentsUpdated++
                    }
                    catch (err) {
                        failed.push({ kind: 'agent', externalId: change.externalId, op: 'UPDATE', error: getErrorMessage(err) })
                    }
                }

                applied.agentsUnchanged = plan.changes.unchanged.filter((u) => u.kind === 'agent').length

                // Phase 2: Trigger Bindings CREATE / UPDATE
                for (const change of plan.changes.creates.filter((c) => c.kind === 'trigger_binding')) {
                    try {
                        const srcTb = snapshot.triggerBindings.find((b) => b.externalId === change.externalId || `${b.pieceName}::${b.triggerName}` === change.externalId)
                        if (srcTb && failedCustomPieceNames.has(srcTb.pieceName)) {
                            failed.push({
                                kind: 'trigger_binding',
                                externalId: change.externalId,
                                op: 'CREATE',
                                error: `Activation blocked: dependent custom integration "${srcTb.pieceName}" failed to install`,
                            })
                            continue
                        }
                        if (srcTb) {
                            let connectionId: string | undefined = undefined
                            if (srcTb.connectionExternalId) {
                                if (failedConnectionExternalIds.has(srcTb.connectionExternalId)) {
                                    failed.push({
                                        kind: 'trigger_binding',
                                        externalId: change.externalId,
                                        op: 'CREATE',
                                        error: `Activation blocked: required connection "${srcTb.connectionExternalId}" failed to resolve or bootstrap`,
                                    })
                                    continue
                                }
                                connectionId = resolvedConnections.get(srcTb.connectionExternalId)
                                if (!connectionId) {
                                    failed.push({
                                        kind: 'trigger_binding',
                                        externalId: change.externalId,
                                        op: 'CREATE',
                                        error: `Activation blocked: required connection "${srcTb.connectionExternalId}" is not available`,
                                    })
                                    continue
                                }
                            }

                            await triggerBindingService.create({
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                                request: {
                                    pieceName: srcTb.pieceName,
                                    pieceVersion: srcTb.pieceVersion,
                                    triggerName: srcTb.triggerName,
                                    promptTemplate: srcTb.promptTemplate,
                                    connectionId,
                                    settings: srcTb.settings,
                                    propertySettings: srcTb.propertySettings ?? undefined,
                                    status: (srcTb.status as TriggerBindingStatus) ?? TriggerBindingStatus.ENABLED,
                                },
                            })
                            applied.triggerBindingsCreated++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'trigger_binding', externalId: change.externalId, op: 'CREATE', error: getErrorMessage(err) })
                    }
                }

                for (const change of plan.changes.updates.filter((c) => c.kind === 'trigger_binding')) {
                    try {
                        const targetTb = await triggerBindingRepo().findOneBy({ id: change.externalId, projectId: targetProjectId })
                        const srcTb = snapshot.triggerBindings.find((b) => b.externalId === change.externalId || (targetTb && b.pieceName === targetTb.pieceName && b.triggerName === targetTb.triggerName))
                        if (srcTb && failedCustomPieceNames.has(srcTb.pieceName)) {
                            failed.push({
                                kind: 'trigger_binding',
                                externalId: change.externalId,
                                op: 'UPDATE',
                                error: `Activation blocked: dependent custom integration "${srcTb.pieceName}" failed to install`,
                            })
                            continue
                        }
                        if (srcTb && targetTb) {
                            let connectionId: string | undefined = targetTb.connectionId ?? undefined
                            if (srcTb.connectionExternalId) {
                                if (failedConnectionExternalIds.has(srcTb.connectionExternalId)) {
                                    failed.push({
                                        kind: 'trigger_binding',
                                        externalId: change.externalId,
                                        op: 'UPDATE',
                                        error: `Activation blocked: required connection "${srcTb.connectionExternalId}" failed to resolve or bootstrap`,
                                    })
                                    continue
                                }
                                connectionId = resolvedConnections.get(srcTb.connectionExternalId)
                                if (!connectionId) {
                                    failed.push({
                                        kind: 'trigger_binding',
                                        externalId: change.externalId,
                                        op: 'UPDATE',
                                        error: `Activation blocked: required connection "${srcTb.connectionExternalId}" is not available`,
                                    })
                                    continue
                                }
                            }
                            await triggerBindingService.update({
                                id: targetTb.id,
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                                request: {
                                    promptTemplate: srcTb.promptTemplate,
                                    connectionId,
                                    settings: srcTb.settings,
                                    propertySettings: srcTb.propertySettings ?? undefined,
                                    status: (srcTb.status as TriggerBindingStatus) ?? TriggerBindingStatus.ENABLED,
                                },
                            })
                            applied.triggerBindingsUpdated++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'trigger_binding', externalId: change.externalId, op: 'UPDATE', error: getErrorMessage(err) })
                    }
                }

                applied.triggerBindingsUnchanged = plan.changes.unchanged.filter((u) => u.kind === 'trigger_binding').length

                // Phase 3: Scheduled Tasks CREATE / UPDATE
                for (const change of plan.changes.creates.filter((c) => c.kind === 'scheduled_task')) {
                    try {
                        const srcSt = snapshot.scheduledTasks.find((s) => s.externalId === change.externalId || `${s.prompt}::${s.cronExpression}` === change.externalId)
                        if (srcSt) {
                            await scheduledTaskService.create({
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                                request: {
                                    prompt: srcSt.prompt,
                                    cronExpression: srcSt.cronExpression,
                                    timezone: srcSt.timezone,
                                    status: (srcSt.status as ScheduledTaskStatus) ?? ScheduledTaskStatus.ENABLED,
                                },
                            })
                            applied.scheduledTasksCreated++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'scheduled_task', externalId: change.externalId, op: 'CREATE', error: getErrorMessage(err) })
                    }
                }

                for (const change of plan.changes.updates.filter((c) => c.kind === 'scheduled_task')) {
                    try {
                        const targetSt = await scheduledTaskRepo().findOneBy({ id: change.externalId, projectId: targetProjectId })
                        const srcSt = snapshot.scheduledTasks.find((s) => s.externalId === change.externalId || (targetSt && s.prompt === targetSt.prompt && s.cronExpression === targetSt.cronExpression))
                        if (srcSt && targetSt) {
                            await scheduledTaskService.update({
                                id: targetSt.id,
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                                request: {
                                    prompt: srcSt.prompt,
                                    cronExpression: srcSt.cronExpression,
                                    timezone: srcSt.timezone,
                                    status: (srcSt.status as ScheduledTaskStatus) ?? ScheduledTaskStatus.ENABLED,
                                },
                            })
                            applied.scheduledTasksUpdated++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'scheduled_task', externalId: change.externalId, op: 'UPDATE', error: getErrorMessage(err) })
                    }
                }

                applied.scheduledTasksUnchanged = plan.changes.unchanged.filter((u) => u.kind === 'scheduled_task').length

                // Phase 4.5: MCP CREATE & UPDATE
                const mcpCreate = plan.changes.creates.find((c) => c.kind === 'mcp_server')
                if (mcpCreate && snapshot.mcp) {
                    try {
                        await mcpServerService(log).update({
                            projectId: targetProjectId,
                            disabledTools: snapshot.mcp.disabledTools ?? [],
                        })
                        applied.mcpCreated++
                    }
                    catch (err) {
                        failed.push({ kind: 'mcp_server', externalId: mcpCreate.externalId, op: 'CREATE', error: getErrorMessage(err) })
                    }
                }

                const mcpUpdate = plan.changes.updates.find((c) => c.kind === 'mcp_server')
                if (mcpUpdate && snapshot.mcp) {
                    try {
                        await mcpServerService(log).update({
                            projectId: targetProjectId,
                            disabledTools: snapshot.mcp.disabledTools ?? [],
                        })
                        applied.mcpUpdated++
                    }
                    catch (err) {
                        failed.push({ kind: 'mcp_server', externalId: mcpUpdate.externalId, op: 'UPDATE', error: getErrorMessage(err) })
                    }
                }

                applied.mcpUnchanged = plan.changes.unchanged.filter((u) => u.kind === 'mcp_server').length

                // Phase 4.8: MCP DELETE (mcp_server is first in delete order)
                for (const change of plan.changes.deletes.filter((c) => c.kind === 'mcp_server')) {
                    try {
                        await mcpServerRepository().delete({ projectId: targetProjectId })
                        applied.mcpDeleted++
                    }
                    catch (err) {
                        failed.push({ kind: 'mcp_server', externalId: change.externalId, op: 'DELETE', error: getErrorMessage(err) })
                    }
                }

                // Phase 5: Scheduled Tasks DELETE
                for (const change of plan.changes.deletes.filter((c) => c.kind === 'scheduled_task')) {
                    try {
                        const targetSt = await scheduledTaskRepo().findOneBy({ id: change.externalId, projectId: targetProjectId })
                            || await scheduledTaskRepo().findOneBy({ projectId: targetProjectId, prompt: change.name })
                        if (targetSt) {
                            await scheduledTaskService.delete({
                                id: targetSt.id,
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                            })
                            applied.scheduledTasksDeleted++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'scheduled_task', externalId: change.externalId, op: 'DELETE', error: getErrorMessage(err) })
                    }
                }

                // Phase 6: Trigger Bindings DELETE
                for (const change of plan.changes.deletes.filter((c) => c.kind === 'trigger_binding')) {
                    try {
                        const targetTb = await triggerBindingRepo().findOneBy({ id: change.externalId, projectId: targetProjectId })
                        if (targetTb) {
                            await triggerBindingService.delete({
                                id: targetTb.id,
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                            })
                            applied.triggerBindingsDeleted++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'trigger_binding', externalId: change.externalId, op: 'DELETE', error: getErrorMessage(err) })
                    }
                }

                // Phase 6.5: Agents DELETE (After Trigger Bindings and Tasks are deleted, Before Tables are deleted)
                for (const change of plan.changes.deletes.filter((c) => c.kind === 'agent')) {
                    try {
                        const existing = await agentRepo().findOneBy({ projectId: targetProjectId, externalId: change.externalId })
                        if (existing) {
                            await agentService.delete({
                                id: existing.id,
                                projectId: targetProjectId,
                                platformId: targetPlatformId,
                            })
                            applied.agentsDeleted++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'agent', externalId: change.externalId, op: 'DELETE', error: getErrorMessage(err) })
                    }
                }

                // Phase 7: Tables DELETE
                for (const change of plan.changes.deletes.filter((c) => c.kind === 'table')) {
                    try {
                        const targetTbl = await tableRepo().findOneBy({ projectId: targetProjectId, externalId: change.externalId })
                        if (targetTbl) {
                            await tableService.delete({
                                id: targetTbl.id,
                                projectId: targetProjectId,
                            })
                            applied.tablesDeleted++
                        }
                    }
                    catch (err) {
                        failed.push({ kind: 'table', externalId: change.externalId, op: 'DELETE', error: getErrorMessage(err) })
                    }
                }

                // Phase 8: MCP Token Rotation (only if MCP exists and was not deleted)
                let mcpCredentials: { token: string, serverUrl?: string } | null = null
                if (request.rotateMcpToken) {
                    const hasMcpDelete = plan.changes.deletes.some((d) => d.kind === 'mcp_server')
                    const existingMcp = await mcpServerRepository().findOneBy({ projectId: targetProjectId })
                    if (existingMcp && !hasMcpDelete) {
                        try {
                            const rotated = await mcpServerService(log).rotateToken({ projectId: targetProjectId })
                            const frontendUrl = system.get(AppSystemProp.FRONTEND_URL)
                            mcpCredentials = {
                                token: rotated.token,
                                serverUrl: frontendUrl ? `${frontendUrl}/mcp` : undefined,
                            }
                        }
                        catch (err) {
                            failed.push({ kind: 'mcp_server', externalId: 'default', op: 'ROTATE', error: getErrorMessage(err) })
                        }
                    }
                }

                return {
                    applied,
                    failed,
                    mcpCredentials,
                    durationMs: Date.now() - startTime,
                }
            },
        })
    },
})

export const projectReplaceTesting = {
    canonicalJson,
    computePlanSignature,
    computeSha256,
    sanitizeMappingForPlan,
    getSigningSecret,
    extractAgentsFromFlows,
    isTableNotFoundError,
}
