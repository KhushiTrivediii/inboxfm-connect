import {
    AppConnectionScope,
    GetOrDeleteConnectionFromTokenRequest,
    ListConnectionKeysRequest,
    PrincipalType,
    UpsertConnectionFromToken, UpsertSigningKeyConnection } from '@inboxfm-connect/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { appConnectionService } from '../../app-connection/app-connection-service/app-connection-service'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { projectService } from '../../project/project-service'
import { ConnectionKeyEntity } from './connection-key.entity'
import { connectionKeyService } from './connection-key.service'

export const connectionKeyModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(connectionKeyController, {
        prefix: '/v1/connection-keys',
    })
}

const DEFAULT_LIMIT_SIZE = 10

const connectionKeyController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.delete(
        '/connections',
        {
            config: {
                security: securityAccess.public(),
            },
            schema: {
                querystring: GetOrDeleteConnectionFromTokenRequest,
            },
        },
        async (request) => {
            const appConnection = await connectionKeyService(request.log).getConnection(
                request.query,
            )
            const platformId = await projectService(request.log).getPlatformId(request.query.projectId)
            if (appConnection !== null) {
                await appConnectionService(request.log).delete({
                    scope: AppConnectionScope.PROJECT,
                    platformId,
                    projectId: request.query.projectId,
                    id: appConnection.id,
                })
            }
        },
    )

    fastify.get(
        '/connections',
        {
            config: {
                security: securityAccess.public(),
            },
            schema: {
                querystring: GetOrDeleteConnectionFromTokenRequest,
            },
        },
        async (
            request: FastifyRequest<{
                Querystring: GetOrDeleteConnectionFromTokenRequest
            }>,
        ) => {
            return connectionKeyService(request.log).getConnection(request.query)
        },
    )

    fastify.post(
        '/connections',
        {
            config: {
                security: securityAccess.public(),
            },
            schema: {
                body: UpsertConnectionFromToken,
            },
        },
        async (request) => {
            return connectionKeyService(request.log).createConnection(request.body)
        },
    )

    fastify.get(
        '/',
        {
            schema: {
                querystring: ListConnectionKeysRequest,
            },
            config: {
                security: securityAccess.project(
                    [PrincipalType.USER, PrincipalType.SERVICE],
                    undefined,
                    {
                        type: ProjectResourceType.QUERY,
                    },
                ),
            },
        },
        async (
            request,
        ) => {
            return connectionKeyService(request.log).list(
                request.projectId,
                request.query.cursor ?? null,
                request.query.limit ?? DEFAULT_LIMIT_SIZE,
            )
        },
    )

    fastify.post(
        '/',
        {
            schema: {
                body: UpsertSigningKeyConnection,
            },
            config: {
                security: securityAccess.project(
                    [PrincipalType.USER, PrincipalType.SERVICE],
                    undefined,
                    {
                        type: ProjectResourceType.BODY,
                    },
                ),
            },
        },
        async (
            request,
        ) => {
            return connectionKeyService(request.log).upsert({
                projectId: request.projectId,
                request: request.body,
            })
        },
    )

    fastify.delete(
        '/:connectionkeyId',
        {
            config: {
                // Issue #413: without a security config the route is treated as
                // PUBLIC by the authn/authz middlewares, and the id-only delete
                // below is cross-tenant. TABLE binds authz to the row's own
                // projectId (looked up by the :connectionkeyId param) and 404s
                // on unknown ids — same shape as app-credentials DELETE /:id.
                security: securityAccess.project(
                    [PrincipalType.USER, PrincipalType.SERVICE],
                    undefined,
                    {
                        type: ProjectResourceType.TABLE,
                        tableName: ConnectionKeyEntity,
                        lookup: { paramKey: 'connectionkeyId', entityField: 'id' },
                    },
                ),
            },
            schema: {
                params: z.object({ connectionkeyId: z.string() }),
            },
        },
        async (request, reply) => {
            await connectionKeyService(request.log).delete({
                id: request.params.connectionkeyId,
                projectId: request.projectId,
            })
            return reply.status(StatusCodes.OK).send()
        },
    )
}
