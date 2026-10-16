import { HeadlessRuntime } from '@inboxfm-connect/runtime'
import { apLogger } from '@inboxfm-connect/server-utils'
import { McpToolResult, NetworkMode } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { ArrayContains } from 'typeorm'
import { appConnectionService, appConnectionsRepo } from '../../app-connection/app-connection-service/app-connection-service'
import { AppConnectionSchema } from '../../app-connection/app-connection.entity'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { localPieceCatalog } from '../../pieces/metadata/local-piece-catalog'
import { projectService } from '../../project/project-service'

const runtimeLog = apLogger.create({ bindings: {} })

const runtime = new HeadlessRuntime<AppConnectionSchema>({
    basePath: process.cwd(),
    log: runtimeLog,
    getSettings: () => ({
        EXECUTION_MODE: system.get(AppSystemProp.EXECUTION_MODE) ?? 'UNSANDBOXED',
        SANDBOX_MEMORY_LIMIT: system.get(AppSystemProp.SANDBOX_MEMORY_LIMIT) ?? '1048576',
        FLOW_TIMEOUT_SECONDS: Number(system.get(AppSystemProp.FLOW_TIMEOUT_SECONDS) ?? '60'),
        MAX_FLOW_RUN_LOG_SIZE_MB: Number(system.get(AppSystemProp.MAX_FLOW_RUN_LOG_SIZE_MB) ?? '1'),
        MAX_FILE_SIZE_MB: Number(system.get(AppSystemProp.MAX_FILE_SIZE_MB) ?? '10'),
        NETWORK_MODE: system.get(AppSystemProp.NETWORK_MODE) === NetworkMode.UNRESTRICTED ? NetworkMode.UNRESTRICTED : NetworkMode.STRICT,
        DEV_PIECES: (system.get(AppSystemProp.DEV_PIECES) ?? '').split(',').map(value => value.trim()).filter(Boolean),
        ENVIRONMENT: system.get(AppSystemProp.ENVIRONMENT) ?? '',
        REUSE_SANDBOX: undefined,
        SANDBOX_PROPAGATED_ENV_VARS: [],
        SSRF_ALLOW_LIST: (system.get(AppSystemProp.SSRF_ALLOW_LIST) ?? '').split(',').map(value => value.trim()).filter(Boolean),
        WORKER_GROUP_ID: 'headless',
        PROJECT_WORKER: false,
    }),
    database: {
        async getConnection({ connectionId }) {
            const connection = await appConnectionsRepo().findOneBy({ id: connectionId })
            return connection ?? null
        },
        async saveConnection({ connection }) {
            await appConnectionsRepo().save(connection)
        },
        async deleteConnection({ connectionId }) {
            await appConnectionsRepo().delete({ id: connectionId })
        },
    },
    decryptAndRefresh: async ({ connection }) => {
        const projectId = connection.projectIds?.[0]
        if (!projectId) {
            throw new Error(`Connection has no projectIds: ${connection.id}`)
        }
        return appConnectionService(runtimeLog).decryptAndRefreshConnection(
            connection,
            projectId,
            runtimeLog,
        )
    },
})

export async function executeAdhocAction({
    projectId,
    pieceName,
    actionName,
    input = {},
    connectionExternalId,
    log,
}: {
    projectId: string
    pieceName: string
    actionName: string
    input?: Record<string, unknown>
    connectionExternalId?: string
    log: FastifyBaseLogger
}): Promise<McpToolResult> {
    const project = await projectService(log).getOneOrThrow(projectId)

    // Resolution is strictly piece-scoped: a connection from another piece must never
    // be paired with this piece's name at execute time — the engine would fetch a
    // bundle version that exists nowhere (the Frankenstein pair).
    const normalizedPieceName = localPieceCatalog.normalizePieceName(pieceName)
    const projectConnections = await appConnectionsRepo().find({
        projectIds: ArrayContains([projectId]),
    })

    const belongsToRequestedPiece = (candidate: AppConnectionSchema) =>
        localPieceCatalog.normalizePieceName(candidate.pieceName) === normalizedPieceName

    const connection = (connectionExternalId
        ? projectConnections.find((candidate) => candidate.externalId === connectionExternalId && belongsToRequestedPiece(candidate))
        : undefined) ?? projectConnections.find(belongsToRequestedPiece)

    if (!connection) {
        throw new Error(
            projectConnections.length === 0
                ? 'A connection must be created first before executing a tool.'
                : `No connection found for integration "${pieceName}" in this project. Existing connections: ${projectConnections.map((candidate) => `${candidate.externalId} (${candidate.pieceName})`).join(', ')}. Create a connection for this integration, or pass connectionExternalId of a connection that belongs to it.`,
        )
    }

    const publicUrl = system.get(AppSystemProp.FRONTEND_URL) || 'http://localhost:3000'
    const result = await runtime.execute({
        integration: pieceName,
        tool: actionName,
        connectionId: connection.id,
        input,
        projectId,
        platformId: project.platformId,
        internalApiUrl: publicUrl,
        publicApiUrl: publicUrl,
    })

    const text = `Result:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``
    return { content: [{ type: 'text', text }] }
}
