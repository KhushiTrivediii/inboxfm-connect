import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import {
    CreateConnectMcpTokenRequest,
    CreateConnectMcpTokenResponse,
    ExternalUserMcpContext,
} from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { JwtAudience, jwtUtils } from '../helper/jwt-utils'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { projectService } from '../project/project-service'

const DEFAULT_MCP_TOKEN_EXPIRY_SECONDS = 3600 // 1 hour
const MAX_MCP_TOKEN_EXPIRY_SECONDS = 7 * 86400 // 7 days

export type ConnectMcpTokenPayload = {
    sub: string
    externalUserId: string
    projectId: string
    platformId: string
    allowedPieceNames: string[] | null
    clientId: string
    scopes: string[]
    type: 'mcp_external_user'
    iat: number
    exp: number
}

export const connectMcpService = (log: FastifyBaseLogger) => ({
    async issueToken({
        projectId,
        externalUserId,
        allowedPieceNames,
        expiresInSeconds,
    }: CreateConnectMcpTokenRequest): Promise<CreateConnectMcpTokenResponse> {
        if (!externalUserId || externalUserId.trim().length === 0) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'externalUserId cannot be empty',
                },
            })
        }

        const project = await projectService(log).getOneOrThrow(projectId)
        const ttl = Math.min(
            expiresInSeconds ?? DEFAULT_MCP_TOKEN_EXPIRY_SECONDS,
            MAX_MCP_TOKEN_EXPIRY_SECONDS,
        )

        const key = await jwtUtils.getJwtSecret()
        const token = await jwtUtils.sign({
            payload: {
                sub: externalUserId,
                externalUserId,
                projectId,
                platformId: project.platformId,
                allowedPieceNames: allowedPieceNames ?? null,
                clientId: 'connect-mcp',
                scopes: ['mcp'],
                type: 'mcp_external_user',
            },
            key,
            expiresInSeconds: ttl,
            audience: JwtAudience.CONNECT_EXTERNAL_MCP,
        })

        const expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
        const frontendUrl = system.get(AppSystemProp.FRONTEND_URL) || 'http://localhost:3000'
        const mcpServerUrl = `${frontendUrl.replace(/\/+$/, '')}/mcp`

        return {
            token,
            mcpServerUrl,
            expiresAt,
            projectId,
            externalUserId,
            allowedPieceNames: allowedPieceNames ?? null,
        }
    },

    async verifyToken(token: string): Promise<ExternalUserMcpContext> {
        const key = await jwtUtils.getJwtSecret()
        const payload = await jwtUtils.decodeAndVerify<ConnectMcpTokenPayload>({
            jwt: token,
            key,
            audience: JwtAudience.CONNECT_EXTERNAL_MCP,
        })

        if (payload.type !== 'mcp_external_user' || !payload.externalUserId) {
            throw new ActivepiecesError({
                code: ErrorCode.AUTHENTICATION,
                params: {
                    message: 'Invalid external user MCP token payload',
                },
            })
        }

        return {
            externalUserId: payload.externalUserId,
            projectId: payload.projectId,
            platformId: payload.platformId,
            allowedPieceNames: payload.allowedPieceNames,
        }
    },
})
