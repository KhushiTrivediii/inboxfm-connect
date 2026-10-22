import { Permission } from '@inboxfm-connect/core-utils'
import {
    CreateConnectMcpTokenRequest,
    CreateConnectMcpTokenResponse,
    PrincipalType,
} from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { ProjectResourceType } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { connectMcpService } from './connect-mcp.service'

export const connectMcpController: FastifyPluginAsyncZod = async (app) => {
    app.post('/token', CreateConnectMcpTokenRoute, async (req, res) => {
        const result = await connectMcpService(req.log).issueToken({
            projectId: req.body.projectId,
            externalUserId: req.body.externalUserId,
            allowedPieceNames: req.body.allowedPieceNames,
            expiresInSeconds: req.body.expiresInSeconds,
        })
        return res.status(StatusCodes.CREATED).send(result)
    })
}

const CreateConnectMcpTokenRoute = {
    config: {
        security: securityAccess.project(
            [PrincipalType.SERVICE, PrincipalType.USER],
            Permission.WRITE_APP_CONNECTION,
            { type: ProjectResourceType.BODY },
        ),
    },
    schema: {
        tags: ['connect-mcp'],
        description: 'Delegate a bounded, short-lived MCP token for an authenticated external customer without exposing project API keys',
        body: CreateConnectMcpTokenRequest,
        response: {
            [StatusCodes.CREATED]: CreateConnectMcpTokenResponse,
        },
    },
}
