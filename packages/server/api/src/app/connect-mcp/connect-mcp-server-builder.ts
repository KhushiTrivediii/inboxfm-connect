import {
    AppConnectionStatus,
    ExternalUserMcpContext,
} from '@inboxfm-connect/shared'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FastifyBaseLogger } from 'fastify'
import { ArrayContains } from 'typeorm'
import { z } from 'zod'
import { appConnectionsRepo } from '../app-connection/app-connection-service/app-connection-service'
import { executeRuntime } from '../execute/execute.controller'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { mcpUtils } from '../mcp/tools/mcp-utils'
import { pieceMetadataService } from '../pieces/metadata/piece-metadata-service'

function sanitizeErrorMessage(msg: string): string {
    return msg
        .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
        .replace(/(access_token|client_secret|api_key|password|secret)["']?\s*[:=]\s*["']?[^"'\s,]+/gi, '$1=[REDACTED]')
}

export async function buildExternalUserMcpServer({
    externalUser,
    log,
}: {
    externalUser: ExternalUserMcpContext
    log: FastifyBaseLogger
}): Promise<McpServer> {
    const server = new McpServer(
        {
            name: 'InboxFM Connect',
            title: 'InboxFM Connect',
            version: '1.0.0',
            description: `Connect customer MCP server delegated for external customer "${externalUser.externalUserId}"`,
        },
        {
            instructions: `## InboxFM Connect Customer MCP Server

This server provides secure access to third-party tools and connected accounts authorized for customer "${externalUser.externalUserId}".

### Available Capabilities
- ap_list_connections: Discover connected accounts (Slack, Google Drive, GitHub, etc.) authorized for this customer session.
- ap_get_piece_props: Inspect parameters and schemas required to call an integration action.
- ap_research_pieces: List allowed integrations and their available actions.
- ap_run_action: Execute an action against a connected integration account on behalf of the customer.

All invocations run with strict customer and project-level boundaries.`,
        },
    )

    // 1. ap_list_connections — lists ONLY active connections for this customer and project
    server.registerTool(
        'ap_list_connections',
        {
            description: 'List authorized integrations and active accounts connected for the authenticated customer. Use to discover connected accounts and retrieve externalId.',
            inputSchema: {
                pieceName: z
                    .string()
                    .optional()
                    .describe('Optional filter by piece name, e.g. "slack" or "@inboxfm-connect/piece-slack".'),
                status: z
                    .array(z.nativeEnum(AppConnectionStatus))
                    .optional()
                    .describe('Filter by connection status. Defaults to ACTIVE.'),
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const pieceFilter = args.pieceName ? mcpUtils.normalizePieceName(args.pieceName) : undefined
                const statusFilter = args.status ?? [AppConnectionStatus.ACTIVE]

                let connections = await appConnectionsRepo().find({
                    where: {
                        projectIds: ArrayContains([externalUser.projectId]),
                        externalId: externalUser.externalUserId,
                    },
                })

                connections = connections.filter((c) => statusFilter.includes(c.status))

                if (pieceFilter) {
                    connections = connections.filter((c) => c.pieceName === pieceFilter)
                }

                if (externalUser.allowedPieceNames && externalUser.allowedPieceNames.length > 0) {
                    const allowedSet = new Set(externalUser.allowedPieceNames.map((p) => mcpUtils.normalizePieceName(p)))
                    connections = connections.filter((c) => allowedSet.has(c.pieceName))
                }

                const lines = connections.map(
                    (c) => `- externalId: ${c.externalId} | displayName: "${c.displayName}" | piece: ${c.pieceName} | status: ${c.status}`,
                )
                const summary = connections.length === 0
                    ? `No connected accounts found for customer "${externalUser.externalUserId}". Please connect an account first.`
                    : `Connected accounts (${connections.length}):\n${lines.join('\n')}`

                return {
                    content: [{ type: 'text', text: summary }],
                    structuredContent: {
                        connections: connections.map((c) => ({
                            externalId: c.externalId,
                            displayName: c.displayName,
                            pieceName: c.pieceName,
                            status: c.status,
                        })),
                    },
                }
            }
            catch (err) {
                log.error({ error: err, externalUser }, 'ap_list_connections failed')
                const safeMessage = sanitizeErrorMessage(err instanceof Error ? err.message : String(err))
                return mcpUtils.mcpToolError('Failed to list connections', new Error(safeMessage))
            }
        },
    )

    // 2. ap_run_action — strictly re-validates customer ownership, piece allowlist, and project boundary
    server.registerTool(
        'ap_run_action',
        {
            description: 'Execute an action on an authorized connected integration on behalf of the authenticated customer.',
            inputSchema: {
                pieceName: z.string().describe('Integration name, e.g. "slack" or "@inboxfm-connect/piece-slack".'),
                actionName: z.string().describe('Action name, e.g. "send_channel_message".'),
                input: z.record(z.string(), z.unknown()).optional().describe('Input properties for the action.'),
                connectionExternalId: z
                    .string()
                    .optional()
                    .describe('Optional externalId of the customer connection. If passed, must match the authenticated customer.'),
            },
            annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
        async (args) => {
            try {
                const pieceName = mcpUtils.normalizePieceName(args.pieceName) ?? args.pieceName
                const actionName = args.actionName
                const input = args.input ?? {}
                const connectionExternalId = args.connectionExternalId

                // 1. Re-validate piece allowance
                if (externalUser.allowedPieceNames && externalUser.allowedPieceNames.length > 0) {
                    const allowedNormalized = externalUser.allowedPieceNames.map((p) => mcpUtils.normalizePieceName(p))
                    if (!allowedNormalized.includes(pieceName)) {
                        return mcpUtils.mcpToolError(
                            'Integration not permitted',
                            new Error(`Integration "${pieceName}" is not permitted for this customer session. Allowed: ${externalUser.allowedPieceNames.join(', ')}`),
                        )
                    }
                }

                // 2. Prevent customer ID substitution
                if (connectionExternalId && connectionExternalId !== externalUser.externalUserId) {
                    return mcpUtils.mcpToolError(
                        'Unauthorized connection',
                        new Error(`Cannot use connection for externalId "${connectionExternalId}". This session is strictly bounded to customer "${externalUser.externalUserId}".`),
                    )
                }

                // 3. Resolve connection strictly for this external user in this project
                const connection = await appConnectionsRepo().findOneBy({
                    projectIds: ArrayContains([externalUser.projectId]),
                    pieceName,
                    externalId: externalUser.externalUserId,
                    status: AppConnectionStatus.ACTIVE,
                })

                if (!connection) {
                    return mcpUtils.mcpToolError(
                        'Connection not found',
                        new Error(`No active connection found for integration "${pieceName}" and customer "${externalUser.externalUserId}". Please connect your account before executing actions.`),
                    )
                }

                // 4. Execute through headless runtime
                const publicUrl = system.get(AppSystemProp.FRONTEND_URL) || 'http://localhost:3000'
                const result = await executeRuntime.execute({
                    integration: pieceName,
                    tool: actionName,
                    connectionId: connection.id,
                    input,
                    projectId: externalUser.projectId,
                    platformId: externalUser.platformId,
                    internalApiUrl: publicUrl,
                    publicApiUrl: publicUrl,
                })

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Result:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
                        },
                    ],
                    structuredContent: result as Record<string, unknown>,
                }
            }
            catch (err) {
                log.error({ error: err, externalUserId: externalUser.externalUserId, projectId: externalUser.projectId }, 'External user MCP execution failed')
                const safeMessage = sanitizeErrorMessage(err instanceof Error ? err.message : String(err))
                return mcpUtils.mcpToolError('Execution failed', new Error(safeMessage))
            }
        },
    )

    // 3. ap_get_piece_props — get action schema for parameterization
    server.registerTool(
        'ap_get_piece_props',
        {
            description: 'Get parameter schema for an action on an integration.',
            inputSchema: {
                pieceName: z.string().describe('Integration name, e.g. "@inboxfm-connect/piece-slack" or "slack".'),
                actionName: z.string().describe('Action name.'),
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const pieceName = mcpUtils.normalizePieceName(args.pieceName) ?? args.pieceName
                if (externalUser.allowedPieceNames && externalUser.allowedPieceNames.length > 0) {
                    const allowed = externalUser.allowedPieceNames.map((p) => mcpUtils.normalizePieceName(p))
                    if (!allowed.includes(pieceName)) {
                        return mcpUtils.mcpToolError('Integration not permitted', new Error(`Integration "${pieceName}" is not permitted for this customer session.`))
                    }
                }

                const piece = await pieceMetadataService(log).getOrThrow({
                    name: pieceName,
                    version: undefined,
                    projectId: externalUser.projectId,
                })

                const action = piece.actions[args.actionName]
                if (!action) {
                    return mcpUtils.mcpToolError('Action not found', new Error(`Action "${args.actionName}" not found on "${pieceName}".`))
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(action.props, null, 2),
                        },
                    ],
                    structuredContent: action.props as Record<string, unknown>,
                }
            }
            catch (err) {
                log.error({ error: err, pieceName: args.pieceName }, 'ap_get_piece_props failed')
                return mcpUtils.mcpToolError('Failed to get piece props', err)
            }
        },
    )

    // 4. ap_research_pieces — discover available / allowed integrations
    server.registerTool(
        'ap_research_pieces',
        {
            description: 'List available integrations and their actions authorized for this customer session.',
            inputSchema: {
                searchQuery: z.string().optional().describe('Optional search query to filter piece names or descriptions.'),
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const pieces = await pieceMetadataService(log).list({
                    projectId: externalUser.projectId,
                    platformId: externalUser.platformId,
                    includeHidden: false,
                })

                let filtered = pieces
                if (externalUser.allowedPieceNames && externalUser.allowedPieceNames.length > 0) {
                    const allowedSet = new Set(externalUser.allowedPieceNames.map((p) => mcpUtils.normalizePieceName(p)))
                    filtered = filtered.filter((p) => allowedSet.has(p.name))
                }

                if (args.searchQuery) {
                    const q = args.searchQuery.toLowerCase()
                    filtered = filtered.filter((p) => p.name.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
                }

                const summary = filtered.map((p) => `- ${p.name} (${p.displayName}): ${p.description} [${Object.keys(p.actions).length} actions]`).join('\n')
                return {
                    content: [{ type: 'text', text: summary || 'No matching integrations found.' }],
                    structuredContent: {
                        pieces: filtered.map((p) => ({
                            name: p.name,
                            displayName: p.displayName,
                            description: p.description,
                            actionNames: Object.keys(p.actions),
                        })),
                    },
                }
            }
            catch (err) {
                log.error({ error: err }, 'ap_research_pieces failed')
                return mcpUtils.mcpToolError('Failed to list integrations', err)
            }
        },
    )

    return server
}
