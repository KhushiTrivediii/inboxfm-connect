import { ActivepiecesError, ErrorCode, isNil, tryCatch } from '@inboxfm-connect/core-utils'
import { HeadlessRuntime } from '@inboxfm-connect/runtime'
import { apLogger } from '@inboxfm-connect/server-utils'
import { ExecuteRequestBody, NetworkMode, Permission, PrincipalType } from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { ArrayContains } from 'typeorm'
import { z } from 'zod'
import { appConnectionService, appConnectionsRepo } from '../app-connection/app-connection-service/app-connection-service'
import { AppConnectionSchema } from '../app-connection/app-connection.entity'
import { ProjectResourceType } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { syncExecutionRateLimitOptions } from '../core/security/rate-limit'
import { domainHelper } from '../helper/domain-helper'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'

// The runtime's database callbacks fire outside any request, so they cannot borrow
// request.log — they get the same structured root logger the request hook builds.
const runtimeLog = apLogger.create({ bindings: {} })

export const executeRuntime = new HeadlessRuntime<AppConnectionSchema>({
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

export const executeController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post('/', ExecuteRequestOptions, async (request) => {
        // The runtime builds sandbox-internal URLs (store entries, piece bundles) by appending
        // `v1/...` to this value, so it must carry the `/api` prefix. Raw AP_FRONTEND_URL was the
        // one call site skipping domainHelper — the mismatch produced `/api/api/...` paths (#440).
        const publicUrl = await domainHelper.getPublicApiUrl({ path: '' })
        const connectionId = await resolveConnectionId({
            projectId: request.projectId,
            platformId: request.principal.platform.id,
            connectionId: request.body.connectionId,
            externalUserId: request.body.externalUserId,
            pieceName: request.body.integration,
        })

        const { data, error } = await tryCatch(() => executeRuntime.execute({
            integration: request.body.integration,
            tool: request.body.tool,
            connectionId,
            input: request.body.input,
            projectId: request.projectId,
            platformId: request.principal.platform.id,
            internalApiUrl: publicUrl,
            publicApiUrl: publicUrl,
        }))
        if (error) {
            throw new ActivepiecesError({
                code: ErrorCode.ENGINE_OPERATION_FAILURE,
                params: {
                    message: error instanceof Error ? error.message : 'Failed to execute piece action',
                },
            })
        }
        return data
    })
}

async function resolveConnectionId({ projectId, platformId, connectionId, externalUserId, pieceName }: ResolveConnectionIdParams): Promise<string> {
    if (!isNil(connectionId)) {
        return resolveExplicitConnectionId({ projectId, platformId, connectionId, externalUserId, pieceName })
    }
    if (isNil(externalUserId)) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: {
                message: 'Either connectionId or externalUserId must be provided',
            },
        })
    }
    const connection = await appConnectionsRepo().findOneBy({
        projectIds: ArrayContains([projectId]),
        pieceName,
        externalId: externalUserId,
    })
    if (isNil(connection)) {
        throw new ActivepiecesError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityType: 'app_connection',
                message: `No connection found for piece "${pieceName}" and externalUserId "${externalUserId}"`,
            },
        })
    }
    return connection.id
}

// A named connectionId is an opaque handle, not proof of ownership — it is the one
// resolution path that never filters on the caller's project. It is therefore
// re-resolved against the authorized project (and platform) before use, and, when
// the caller also names an externalUserId, pinned to that same customer, so a
// connection id harvested from another tenant or another customer of this project
// resolves to "not found" instead of reaching the runtime.
async function resolveExplicitConnectionId({ projectId, platformId, connectionId, externalUserId, pieceName }: ResolveExplicitConnectionIdParams): Promise<string> {
    const connection = await appConnectionsRepo().findOneBy({
        id: connectionId,
        platformId,
        pieceName,
        projectIds: ArrayContains([projectId]),
    })
    const belongsToAnotherCustomer = !isNil(connection) && !isNil(externalUserId) && connection.externalId !== externalUserId
    if (isNil(connection) || belongsToAnotherCustomer) {
        throw new ActivepiecesError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityType: 'app_connection',
                message: 'Connection not found',
            },
        })
    }
    return connection.id
}

type ResolveConnectionIdParams = {
    projectId: string
    platformId: string
    connectionId: string | undefined
    externalUserId: string | undefined
    pieceName: string
}

type ResolveExplicitConnectionIdParams = {
    projectId: string
    platformId: string
    connectionId: string
    externalUserId: string | undefined
    pieceName: string
}

/**
 * `projectId` is required by the security layer, not by the runtime.
 * The route is configured with ProjectResourceType.BODY, and the authorization
 * hook runs at `preHandler` — after zod has already stripped unknown keys — so
 * the field must be declared here or every USER principal is rejected with
 * "Project ID is required". Membership + WRITE permission on the named project
 * are still enforced by the authorization layer. Defined in
 * `@inboxfm-connect/shared` (`connect-execute/execute-request.ts`) so the
 * Connect SDK's codegen can derive its request type from this same schema.
 */
const ExecuteRequestOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE],
            Permission.WRITE_APP_CONNECTION,
            { type: ProjectResourceType.BODY },
        ),
        rateLimit: syncExecutionRateLimitOptions,
    },
    schema: {
        tags: ['execute'],
        description: 'Run a single piece action synchronously against one connection, resolved either by connectionId or by pieceName + externalUserId. Returns the raw action output.',
        body: ExecuteRequestBody,
        response: {
            [StatusCodes.OK]: z.unknown(),
        },
    },
}
