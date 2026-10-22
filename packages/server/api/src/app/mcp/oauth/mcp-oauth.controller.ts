import { isNil, tryCatch } from '@inboxfm-connect/core-utils'
import { McpServerType, PopulatedMcpServer, TelemetryEventName } from '@inboxfm-connect/shared'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { buildExternalUserMcpServer } from '../../connect-mcp/connect-mcp-server-builder'
import { connectMcpService } from '../../connect-mcp/connect-mcp.service'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { domainHelper } from '../../helper/domain-helper'
import { rejectedPromiseHandler } from '../../helper/promise-handler'
import { telemetry } from '../../helper/telemetry.utils'
import { mcpServerService } from '../mcp-service'
import { mcpOAuthTokenService } from './token/mcp-oauth-token.service'

export const mcpOAuthHttpController: FastifyPluginAsyncZod = async (app) => {
    registerMcpEndpoint(app, McpServerType.PROJECT)
}

export const connectMcpHttpController: FastifyPluginAsyncZod = async (app) => {
    registerMcpEndpoint(app, McpServerType.PROJECT)
}

export const mcpPlatformHttpController: FastifyPluginAsyncZod = async (app) => {
    registerMcpEndpoint(app, McpServerType.PLATFORM)
}

function registerMcpEndpoint(app: Parameters<FastifyPluginAsyncZod>[0], scope: McpServerType): void {
    app.addContentTypeParser(
        'application/json',
        { parseAs: 'string' },
        (_req, body: string, done) => {
            if (body == null || body.trim() === '') {
                return done(null, {})
            }
            try {
                done(null, JSON.parse(body))
            }
            catch (err) {
                const error: Error & { statusCode?: number } = err instanceof Error ? err : new Error('JSON parsing failed')
                error.statusCode = 400
                done(error, undefined)
            }
        },
    )

    app.get('/', McpEndpointConfig, async (_req, reply) => {
        return reply.status(405).send({
            error: 'Method Not Allowed',
            message: 'Use POST with Authorization: Bearer <token> for MCP requests.',
        })
    })

    app.post('/', McpEndpointConfig, async (req, reply) => {
        const authHeader = req.headers.authorization
        const [type, token] = authHeader?.split(' ') ?? []

        if (type !== 'Bearer' || isNil(token)) {
            return unauthorized({ req, reply, scope, message: 'Authorization: Bearer <token> required' })
        }

        if (scope === McpServerType.PROJECT) {
            const { data: externalUser } = await tryCatch(() => connectMcpService(req.log).verifyToken(token))
            if (externalUser) {
                const server = await buildExternalUserMcpServer({ externalUser, log: req.log })
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                })
                reply.raw.on('close', async () => {
                    // raw-stream 'close' handlers are not awaited by Node, so an
                    // async body must guard itself or a transport/server close
                    // failure becomes an unhandledRejection.
                    try {
                        await transport.close()
                        await server.close()
                    }
                    catch (error) {
                        req.log.error({ error }, '[MCP] Failed to close external-user MCP transport on response close')
                    }
                })
                await server.connect(transport)
                await transport.handleRequest(req.raw, reply.raw, req.body)
                return
            }
        }

        const identity = await resolveIdentity({ token, scope, log: req.log })
        if (isNil(identity)) {
            return unauthorized({ req, reply, scope, message: 'Invalid or expired access token', invalidToken: true })
        }

        const { mcp, userId } = await resolveMcpAndUser({ identity, log: req.log })
        if (isNil(mcp)) {
            return unauthorized({ req, reply, scope, message: 'Invalid project or token.', invalidToken: true })
        }

        const { server } = await mcpServerService(req.log).buildServer({ mcp, userId })

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        })

        reply.raw.on('close', async () => {
            // Guarded for the same reason as the external-user branch above.
            try {
                await transport.close()
                await server.close()
            }
            catch (error) {
                req.log.error({ error }, '[MCP] Failed to close MCP transport on response close')
            }
        })

        await server.connect(transport)
        await transport.handleRequest(req.raw, reply.raw, req.body)
    })
}

function unauthorized({ req, reply, scope, message, invalidToken }: {
    req: FastifyRequest
    reply: FastifyReply
    scope: McpServerType
    message: string
    invalidToken?: boolean
}): FastifyReply {
    const resourcePath = scope === McpServerType.PLATFORM ? 'mcp/platform' : 'mcp'
    const resourceMetadataUrl = domainHelper.getPublicUrlFromRequest({
        req,
        path: `/.well-known/oauth-protected-resource/${resourcePath}`,
    })
    const challenge = invalidToken
        ? `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
        : `Bearer resource_metadata="${resourceMetadataUrl}"`
    return reply.status(401).header('WWW-Authenticate', challenge).send({
        error: 'unauthorized',
        message,
    })
}

async function resolveIdentity({ token, scope, log }: { token: string, scope: McpServerType, log: FastifyBaseLogger }): Promise<ResolvedIdentity | null> {
    const { data: payload, error } = await tryCatch(() => mcpOAuthTokenService.verifyAccessToken(token))
    if (error) {
        log.debug({ error }, 'OAuth token verification failed')
        return null
    }
    const { projectId } = payload
    const isPlatformToken = isNil(projectId)
    if (isPlatformToken && scope === McpServerType.PLATFORM) {
        return { type: McpServerType.PLATFORM, platformId: payload.platformId, userId: payload.sub }
    }
    if (!isPlatformToken && scope === McpServerType.PROJECT) {
        return { type: McpServerType.PROJECT, projectId, userId: payload.sub }
    }
    return null
}

async function resolveMcpAndUser({ identity, log }: { identity: ResolvedIdentity, log: FastifyBaseLogger }): Promise<{ mcp: PopulatedMcpServer | null, userId?: string }> {
    try {
        if (identity.type === McpServerType.PLATFORM) {
            rejectedPromiseHandler(telemetry(log).trackPlatform(identity.platformId, {
                name: TelemetryEventName.MCP_SERVER_CONNECTED,
                payload: {
                    platformId: identity.platformId,
                    userId: identity.userId,
                },
            }), log)
            const mcp = await mcpServerService(log).getPopulatedByPlatformId(identity.platformId)
            return { mcp, userId: identity.userId }
        }
        rejectedPromiseHandler(telemetry(log).trackProject(identity.projectId, {
            name: TelemetryEventName.MCP_SERVER_CONNECTED,
            payload: {
                projectId: identity.projectId,
                userId: identity.userId,
            },
        }), log)
        const mcp = await mcpServerService(log).getPopulatedByProjectId(identity.projectId)
        return { mcp, userId: identity.userId }
    }
    catch (err) {
        log.debug({ error: err }, 'Failed to resolve MCP server')
        return { mcp: null }
    }
}

type ResolvedIdentity =
    | { type: McpServerType.PROJECT, projectId: string, userId: string }
    | { type: McpServerType.PLATFORM, platformId: string, userId: string }



const McpEndpointConfig = {
    config: { security: securityAccess.public() },
    schema: { hide: true },
}
