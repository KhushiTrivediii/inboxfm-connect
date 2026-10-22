import { ConnectProxyRequest, ConnectProxyResponse, Permission, PrincipalType } from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { ProjectResourceType } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { connectProxyService } from './connect-proxy.service'

const ConnectProxyRequestOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_APP_CONNECTION,
            { type: ProjectResourceType.BODY },
        ),
    },
    schema: {
        tags: ['connect-proxy'],
        description: 'Proxy an HTTP request to an allowed third-party provider on behalf of an authenticated customer connection.',
        body: ConnectProxyRequest,
        response: {
            [StatusCodes.OK]: ConnectProxyResponse,
        },
    },
}

export const connectProxyController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post('/request', ConnectProxyRequestOptions, async (request) => {
        return connectProxyService(request.log).execute(request.body)
    })
}
