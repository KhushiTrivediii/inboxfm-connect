import { SeekPage } from '@inboxfm-connect/core-utils'
import { AppCredential, AppCredentialType, ListAppCredentialsRequest, Permission, PrincipalType, UpsertAppCredentialRequest } from '@inboxfm-connect/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { AppCredentialEntity } from './app-credentials.entity'
import { appCredentialService } from './app-credentials.service'

export const appCredentialModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(appCredentialController, {
        prefix: '/v1/app-credentials',
    })
}

const DEFAULT_LIMIT_SIZE = 10

const appCredentialController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.get(
        '/',
        ListCredsRequest,
        async (
            request: FastifyRequest<{
                Querystring: ListAppCredentialsRequest
            }>,
        ) => {
            const page = await appCredentialService.list(
                request.query.projectId,
                request.query.appName,
                request.query.cursor ?? null,
                request.query.limit ?? DEFAULT_LIMIT_SIZE,
            )
            return censorClientSecret(page)
        },
    )

    fastify.post(
        '/',
        UpsertAppCredentialRequestOptions,
        async (request) => {
            return appCredentialService.upsert({
                projectId: request.projectId,
                request: request.body,
            })
        },
    )

    fastify.delete(
        '/:id', DeleteAppCredentialRequestOptions, async (request, reply) => {
            await appCredentialService.delete({
                id: request.params.id,
                projectId: request.projectId,
            })

            return reply.status(StatusCodes.OK).send()
        },
    )
}

function censorClientSecret(
    page: SeekPage<AppCredential>,
): SeekPage<AppCredential> {
    page.data = page.data.map((f) => {
        if (f.settings.type === AppCredentialType.OAUTH2) {
            f.settings.clientSecret = undefined
        }
        return f
    })
    return page
}

// Credential rows carry OAuth client ids and (server-side) secrets, so the list
// route requires a project member with READ_APP_CONNECTION on the projectId in
// the query — not an anonymous enumeration surface (issue #358).
const ListCredsRequest = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.READ_APP_CONNECTION,
            {
                type: ProjectResourceType.QUERY,
                queryKey: 'projectId',
            },
        ),
    },
    schema: {
        querystring: ListAppCredentialsRequest,
    },
}

const UpsertAppCredentialRequestOptions = {
    schema: {
        body: UpsertAppCredentialRequest,
    },
    config: {
        security: securityAccess.project(
            [PrincipalType.USER],
            undefined,
            {
                type: ProjectResourceType.BODY,
            },
        ),
    },
}

const DeleteAppCredentialRequestOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER],
            undefined,
            {
                type: ProjectResourceType.TABLE,
                tableName: AppCredentialEntity,
            },
        ),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
    },
}
