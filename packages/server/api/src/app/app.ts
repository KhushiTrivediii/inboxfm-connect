import swagger from '@fastify/swagger'
import { isNil, spreadIfDefined } from '@inboxfm-connect/core-utils'
import { PieceMetadata } from '@inboxfm-connect/pieces-framework'
import { wideEvent } from '@inboxfm-connect/server-utils'
import { AddAllowedEmbedOriginsRequestBody, ApEdition, ApEnvironment, AppConnectionWithoutSensitiveData, ApplicationEventName, ConnectionDeletedEvent, ConnectionUpsertedEvent, ProjectMember, ProjectRoleEvent, ProjectWithLimits, SigningKeyEvent, SignUpEvent, UserEmailVerifiedEvent, UserInvitation, UserPasswordResetEvent, UserSignedInEvent, UserWithMetaInformation } from '@inboxfm-connect/shared'
import { createAdapter } from '@socket.io/redis-adapter'
import { FastifyInstance, FastifyRequest, HTTPMethods } from 'fastify'
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod'
import Mustache from 'mustache'
import { globalRegistry } from 'zod/v4/core'
import { aiProviderService } from './ai/ai-provider-service'
import { aiProviderModule } from './ai/ai-provider.module'
import { aiToolConfigModule } from './ai/ai-tool-config.module'
import { platformAnalyticsModule } from './analytics/platform-analytics.module'
import { setPlatformOAuthService } from './app-connection/app-connection-service/oauth2'
import { appConnectionModule } from './app-connection/app-connection.module'
import { platformAppConnectionModule } from './app-connection/platform-app-connection.module'
import { authenticationModule } from './authentication/authentication.module'
import { connectApiKeyModule } from './connect-api-keys/connect-api-key.module'
import { connectMcpModule } from './connect-mcp/connect-mcp.module'
import { connectOAuthAppModule } from './connect-oauth-apps/connect-oauth-app.module'
import { connectProxyModule } from './connect-proxy/connect-proxy.module'
import { connectSessionModule } from './connect-sessions/connect-session.module'
import { oidcModule } from './core/security/oidc/oidc.module'
import { publicIngressRateLimitMiddleware } from './core/security/public-ingress-rate-limit-middleware'
import { authenticationMiddleware } from './core/security/v2/authn/authentication-middleware'
import { apiKeyRateLimitMiddleware } from './core/security/v2/authz/api-key-rate-limit-middleware'
import { authorizationMiddleware } from './core/security/v2/authz/authorization-middleware'
import { projectRateLimitMiddleware } from './core/security/v2/authz/project-rate-limit-middleware'
import { distributedLock, redisConnections } from './database/redis-connections'
import { apiKeyModule } from './ee/api-keys/api-key-module'
import { platformOAuth2Service } from './ee/app-connections/platform-oauth2-service'
import { appCredentialModule } from './ee/app-credentials/app-credentials.module'
import { appSumoModule } from './ee/appsumo/appsumo.module'
import { auditEventModule } from './ee/audit-logs/audit-event-module'
import { enterpriseLocalAuthnModule } from './ee/authentication/enterprise-local-authn/enterprise-local-authn-module'
import { federatedAuthModule } from './ee/authentication/federated-authn/federated-authn-module'
import { otpModule } from './ee/authentication/otp/otp-module'
import { rbacMiddleware } from './ee/authentication/project-role/rbac-middleware'
import { authnSsoSamlModule } from './ee/authentication/saml-authn/authn-sso-saml-module'
import { connectionKeyModule } from './ee/connection-keys/connection-key.module'
import { embedSubdomainModule } from './ee/embed-subdomain/embed-subdomain.module'
import { enterpriseFlagsHooks } from './ee/flags/enterprise-flags.hooks'
import { globalConnectionModule } from './ee/global-connections/global-connection-module'
import { licenseKeysModule } from './ee/license-keys/license-keys-module'
import { managedAuthnModule } from './ee/managed-authn/managed-authn-module'
import { oauthAppModule } from './ee/oauth-apps/oauth-app.module'
import { enterpriseFilteringUtils } from './ee/pieces/filters/piece-filtering-utils'
import { platformPieceModule } from './ee/pieces/platform-piece-module'
import { adminPlatformModule } from './ee/platform/admin/admin-platform.controller'
import { concurrencyPoolExecutionHooks } from './ee/platform/concurrency-pool/concurrency-pool-execution-hooks'
import { platformAiCreditsService } from './ee/platform/platform-plan/platform-ai-credits.service'
import { platformPlanModule } from './ee/platform/platform-plan/platform-plan.module'
import { platformWebhooksModule } from './ee/platform-webhooks/platform-webhooks.module'
import { projectEnterpriseHooks } from './ee/projects/ee-project-hooks'
import { platformProjectBackgroundJobs } from './ee/projects/platform-project-jobs'
import { platformProjectModule } from './ee/projects/platform-project-module'
import { projectMemberModule } from './ee/projects/project-members/project-member.module'
import { projectRoleModule } from './ee/projects/project-role/project-role.module'
import { scimModule } from './ee/scim/scim-module'
import { secretManagersModule } from './ee/secret-managers/secret-managers.module'
import { signingKeyModule } from './ee/signing-key/signing-key-module'
import { userModule } from './ee/users/user.module'
import { executeModule } from './execute/execute.module'
import { projectExecutionConcurrencyHooks } from './execution/concurrency/project-execution-concurrency-hooks'
import { executionModule } from './execution/execution.module'
import { fileModule } from './file/file.module'
import { flagModule } from './flags/flag.module'
import { flagHooks } from './flags/flags.hooks'
import { domainHelper } from './helper/domain-helper'
import { exceptionHandler } from './helper/exception-handler'
import { clientLogsModule } from './helper/logs/client-logs.module'
import { openapiModule } from './helper/openapi/openapi.module'
import { rejectedPromiseHandler } from './helper/promise-handler'
import { system } from './helper/system/system'
import { AppSystemProp } from './helper/system/system-props'
import { SystemJobName } from './helper/system-jobs/common'
import { systemJobHandlers } from './helper/system-jobs/job-handlers'
import { systemJobsSchedule } from './helper/system-jobs/system-job'
import { systemSnapshot } from './helper/system-snapshot'
import { validateEnvPropsOnStartup } from './helper/system-validator'
import { shutdownTelemetry } from './helper/telemetry.utils'
import { knowledgeSearchModule } from './knowledge-search/knowledge-search.module'
import { mcpServerModule } from './mcp/mcp-module'
import { communityPiecesModule } from './pieces/community-piece-module'
import { startDevPieceWatcher } from './pieces/dev-piece-watcher'
import { pieceModule } from './pieces/metadata/piece-metadata-controller'
import { pieceMetadataService } from './pieces/metadata/piece-metadata-service'
import { pieceFilteringHooks } from './pieces/metadata/utils/piece-filtering-hooks'
import { pieceBundleModule } from './pieces/piece-bundle-module'
import { pieceSyncService } from './pieces/piece-sync-service'
import { platformBackgroundJobs } from './platform/platform-jobs'
import { platformModule } from './platform/platform.module'
import { projectHooks } from './project/project-hooks'
import { projectReplaceModule } from './project/replace/project-replace.module'
import { storeEntryModule } from './store-entry/store-entry.module'
import { toolSearchReindexJob } from './tool-search/tool-search-reindex.job'
import { platformUserModule } from './user/platform/platform-user-module'
import { invitationModule } from './user-invitations/user-invitation.module'

export const setupApp = async (app: FastifyInstance): Promise<FastifyInstance> => {

    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, async (_request: FastifyRequest, payload: unknown) => {
        return payload as Buffer
    })

    registerOpenApiSchemas()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(swagger as any, {
        hideUntagged: true,
        transform: jsonSchemaTransform,
        transformObject: jsonSchemaTransformObject,
        openapi: {
            openapi: '3.1.0',
            servers: [
                {
                    url: 'https://cloud.activepieces.com/api',
                    description: 'Production Server',
                },
            ],
            components: {
                securitySchemes: {
                    apiKey: {
                        type: 'http',
                        description: 'Use your api key generated from the admin console',
                        scheme: 'bearer',
                    },
                },
                schemas: {
                    'global-connection': { $ref: '#/components/schemas/app-connection' },
                },
            },
            info: {
                title: 'Inboxfm Connect Documentation',
                version: '0.0.0',
            },
            externalDocs: {
                url: 'https://www.activepieces.com/docs',
                description: 'Find more info here',
            },
        },
    })


    app.addHook('onResponse', async (request, reply) => {
        // eslint-disable-next-line                                                                                                                                                                                                                     
        reply.header('x-request-id', request.id)
    })
    app.addHook('onRequest', async (request, reply) => {
        const route = app.hasRoute({
            method: request.method as HTTPMethods,
            url: request.routeOptions.url!,
        })
        request.log = request.log.child({ route: request.routeOptions.url })
        if (!route) {
            return reply.code(404).send({
                statusCode: 404,
                error: 'Not Found',
                message: 'Route not found',
            })
        }
    })

    app.addHook('preHandler', authenticationMiddleware)

    // Enrich the current wide-event with tenant identifiers resolved by the auth middleware.
    // request.principal is set by authenticationMiddleware; for public routes it may be
    // undefined (the middleware returns early), so we guard with a try/catch.
    app.addHook('preHandler', (request, _reply, done) => {
        try {
            const principal = request.principal
            const projectId = extractProjectId(principal)
            const platformId = extractPlatformId(principal)
            wideEvent.set({
                ...spreadIfDefined('project', isNil(projectId) ? undefined : { id: projectId }),
                ...spreadIfDefined('platform', isNil(platformId) ? undefined : { id: platformId }),
                ...spreadIfDefined('principalType', principal?.type),
            })
        }
        catch {
            // principal getter may throw before auth completes — safe to ignore
        }
        done()
    })

    app.addHook('preHandler', authorizationMiddleware)
    app.addHook('preHandler', projectRateLimitMiddleware)
    app.addHook('preHandler', apiKeyRateLimitMiddleware)
    app.addHook('preHandler', publicIngressRateLimitMiddleware)
    app.addHook('preHandler', rbacMiddleware)

    await systemJobsSchedule(app.log).init()
    await app.register(fileModule)
    await app.register(flagModule)
    await app.register(storeEntryModule)
    // await app.register(folderModule)
    await pieceSyncService(app.log).setup()
    toolSearchReindexJob(app.log).register()
    // Cold-start backfill: build the tool-search index once if the flag is on but it has never been
    // built (existing deployment whose piece_metadata is already populated, so no sync delta fires).
    // Fire-and-forget — a no-op once the index has rows, and must never block or fail boot.
    rejectedPromiseHandler(toolSearchReindexJob(app.log).backfillIfEmpty(), app.log)
    await pieceMetadataService(app.log).setup()
    await app.register(pieceModule)
    await app.register(pieceBundleModule)
    // await app.register(collaborativeModule)
    // await app.register(flowModule)
    // await app.register(flowRunModule)
    // await app.register(webhookModule)
    await app.register(appConnectionModule)
    await app.register(platformAppConnectionModule)
    // await app.register(variableModule)
    await app.register(openapiModule)
    // await app.register(appEventRoutingModule)
    await app.register(authenticationModule)
    // await app.register(triggerModule)
    await app.register(platformModule)
    await app.register(executeModule)
    // Original, non-ee Connect platform — available on every edition (see
    // connect-api-keys/, connect-oauth-apps/, connect-sessions/module.ts).
    await app.register(connectApiKeyModule)
    await app.register(connectOAuthAppModule)
    await app.register(connectSessionModule)
    await app.register(connectProxyModule)
    await app.register(connectMcpModule)
    await app.register(executionModule)
    await app.register(knowledgeSearchModule)
    // await app.register(humanInputModule)
    // await app.register(tagsModule)
    // The project MCP configuration endpoints the console reads (`/v1/projects/:projectId/mcp-server`
    // and its rotate/token actions). The entities are already registered in `getEntities()` and the
    // service is headless-adapted, so this only makes the existing contract reachable.
    // Still absent by design: the `POST /mcp` protocol transport and the MCP OAuth
    // authorize/approve flow were removed with the legacy runtime and are not restored here.
    await app.register(mcpServerModule)
    await app.register(projectReplaceModule)
    // await app.register(mcpOAuthApproveController)
    // await app.register(agentsModule)
    await app.register(platformUserModule)
    // await app.register(alertsModule)
    await app.register(invitationModule)
    // await app.register(workerModule)
    // await workerCapacity.setup()
    await app.register(oidcModule)
    await aiProviderService(app.log).setup()
    await app.register(aiProviderModule)
    // await app.register(tablesModule)
    // await app.register(knowledgeBaseModule)
    await app.register(userModule)
    // await app.register(templateModule)
    await app.register(platformAnalyticsModule)

    // Dev-only: accept browser debug logs into the shared evlog fs drain so a
    // chat run can be reconstructed end-to-end (web + api + worker). Never in cloud/prod.
    const clientLogsEnabled = system.get(AppSystemProp.LOG_FILE) === 'true' && system.getEdition() !== ApEdition.CLOUD
    if (clientLogsEnabled) {
        await app.register(clientLogsModule)
    }

    systemJobHandlers.registerJobHandler(SystemJobName.HARD_DELETE_PROJECT, (data) => platformProjectBackgroundJobs(app.log).hardDeleteProjectHandler(data))

    app.get(
        '/redirect',
        async (
            request: FastifyRequest<{ Querystring: { code: string } }>,
            reply,
        ) => {
            const code = request.query.code
            if (!code) {
                return reply.type('text/plain').send('The code is missing in url')
            }
            return reply
                .type('text/html')
                .header('Content-Security-Policy', 'default-src \'none\'; script-src \'unsafe-inline\'')
                .header('X-Content-Type-Options', 'nosniff')
                .send(Mustache.render(REDIRECT_HTML_TEMPLATE, { code }))
        },
    )

    await validateEnvPropsOnStartup(app.log)

    const edition = system.getEdition()
    app.log.info({
        edition,
    }, 'Inboxfm Connect Edition')
    switch (edition) {
        case ApEdition.CLOUD:
            await app.register(licenseKeysModule)
            await app.register(adminPlatformModule)
            await app.register(appCredentialModule)
            await app.register(connectionKeyModule)
            await app.register(platformProjectModule)
            await platformAiCreditsService(app.log).init()
            await app.register(platformPlanModule)
            await app.register(projectMemberModule)
            await app.register(appSumoModule)
            await app.register(signingKeyModule)
            await app.register(authnSsoSamlModule)
            await app.register(managedAuthnModule)
            await app.register(oauthAppModule)
            await app.register(platformPieceModule)
            await app.register(otpModule)
            await app.register(enterpriseLocalAuthnModule)
            await app.register(federatedAuthModule)
            await app.register(apiKeyModule)
            await app.register(auditEventModule)
            await app.register(platformWebhooksModule)
            await app.register(projectRoleModule)
            await app.register(globalConnectionModule)
            await app.register(secretManagersModule)
            await app.register(scimModule)
            await app.register(embedSubdomainModule)
            await app.register(aiToolConfigModule)
            setPlatformOAuthService(platformOAuth2Service(app.log))
            projectHooks.set(projectEnterpriseHooks)
            flagHooks.set(enterpriseFlagsHooks)
            pieceFilteringHooks.set(enterpriseFilteringUtils)
            projectExecutionConcurrencyHooks.set(concurrencyPoolExecutionHooks)
            exceptionHandler.initializeSentry(system.get(AppSystemProp.SENTRY_DSN))
            systemJobHandlers.registerJobHandler(SystemJobName.HARD_DELETE_PLATFORM, (data) => platformBackgroundJobs(app.log).hardDeletePlatformHandler(data))
            break
        case ApEdition.ENTERPRISE:
            await app.register(licenseKeysModule)
            await platformAiCreditsService(app.log).init()
            await app.register(platformPlanModule)
            await app.register(platformProjectModule)
            await app.register(projectMemberModule)
            await app.register(signingKeyModule)
            await app.register(authnSsoSamlModule)
            await app.register(managedAuthnModule)
            await app.register(oauthAppModule)
            await app.register(platformPieceModule)
            await app.register(otpModule)
            await app.register(enterpriseLocalAuthnModule)
            await app.register(federatedAuthModule)
            await app.register(apiKeyModule)
            await app.register(auditEventModule)
            await app.register(platformWebhooksModule)
            await app.register(projectRoleModule)
            await app.register(globalConnectionModule)
            await app.register(secretManagersModule)
            await app.register(scimModule)
            await app.register(embedSubdomainModule)
            await app.register(aiToolConfigModule)
            setPlatformOAuthService(platformOAuth2Service(app.log))
            projectHooks.set(projectEnterpriseHooks)
            flagHooks.set(enterpriseFlagsHooks)
            pieceFilteringHooks.set(enterpriseFilteringUtils)
            projectExecutionConcurrencyHooks.set(concurrencyPoolExecutionHooks)
            break
        case ApEdition.COMMUNITY:
            await app.register(platformProjectModule)
            await app.register(communityPiecesModule)
            break
    }

    await systemJobsSchedule(app.log).startWorker()

    app.addHook('onClose', async () => {
        app.log.info('Shutting down')
        await systemJobsSchedule(app.log).close()
        await redisConnections.destroy()
        await distributedLock(app.log).destroy()
        await shutdownTelemetry()
    })

    return app
}



export async function getAdapter() {
    const redisConnectionInstance = await redisConnections.useExisting()
    const sub = redisConnectionInstance.duplicate()
    const pub = redisConnectionInstance.duplicate()
    return createAdapter(pub, sub, {
        requestsTimeout: 30000,
    })
}


export async function appPostBoot(app: FastifyInstance): Promise<void> {

    app.log.info(`
             _____   _______   _____  __      __  ______   _____    _____   ______    _____   ______    _____
    /\\      / ____| |__   __| |_   _| \\ \\    / / |  ____| |  __ \\  |_   _| |  ____|  / ____| |  ____|  / ____|
   /  \\    | |         | |      | |    \\ \\  / /  | |__    | |__) |   | |   | |__    | |      | |__    | (___
  / /\\ \\   | |         | |      | |     \\ \\/ /   |  __|   |  ___/    | |   |  __|   | |      |  __|    \\___ \\
 / ____ \\  | |____     | |     _| |_     \\  /    | |____  | |       _| |_  | |____  | |____  | |____   ____) |
/_/    \\_\\  \\_____|    |_|    |_____|     \\/     |______| |_|      |_____| |______|  \\_____| |______| |_____/

The application started on ${await domainHelper.getPublicApiUrl({ path: '' })}, as specified by the AP_FRONTEND_URL variables.`)

    const environment = system.get(AppSystemProp.ENVIRONMENT)
    const pieces = process.env.AP_DEV_PIECES

    systemSnapshot.start({ log: app.log })
    // await migrateQueuesAndRunConsumers(app)
    // app.log.info('Queues migrated and consumers run')
    if (environment === ApEnvironment.DEVELOPMENT) {
        app.log.warn(
            `[WARNING]: The application is running in ${environment} mode.`,
        )
        app.log.warn(
            `[WARNING]: This is only shows pieces specified in AP_DEV_PIECES ${pieces} environment variable.`,
        )
    }
    void startDevPieceWatcher(app)
}

function extractPlatformId(principal: { platform?: { id?: string } } | null | undefined): string | undefined {
    return principal?.platform?.id
}

function extractProjectId(principal: { projectId?: string } | null | undefined): string | undefined {
    return principal?.projectId
}

function registerOpenApiSchemas() {
    globalRegistry.add(ConnectionUpsertedEvent, { id: ApplicationEventName.CONNECTION_UPSERTED })
    globalRegistry.add(ConnectionDeletedEvent, { id: ApplicationEventName.CONNECTION_DELETED })
    globalRegistry.add(SignUpEvent, { id: ApplicationEventName.USER_SIGNED_UP })
    globalRegistry.add(UserSignedInEvent, { id: ApplicationEventName.USER_SIGNED_IN })
    globalRegistry.add(UserPasswordResetEvent, { id: ApplicationEventName.USER_PASSWORD_RESET })
    globalRegistry.add(UserEmailVerifiedEvent, { id: ApplicationEventName.USER_EMAIL_VERIFIED })
    globalRegistry.add(SigningKeyEvent, { id: ApplicationEventName.SIGNING_KEY_CREATED })
    globalRegistry.add(ProjectRoleEvent, { id: ApplicationEventName.PROJECT_ROLE_CREATED })
    globalRegistry.add(UserWithMetaInformation, { id: 'user' })
    globalRegistry.add(UserInvitation, { id: 'user-invitation' })
    globalRegistry.add(ProjectMember, { id: 'project-member' })
    globalRegistry.add(ProjectWithLimits, { id: 'project' })
    globalRegistry.add(AppConnectionWithoutSensitiveData, { id: 'app-connection' })
    globalRegistry.add(PieceMetadata, { id: 'piece' })
    globalRegistry.add(AddAllowedEmbedOriginsRequestBody, { id: 'embedding' })
}

const REDIRECT_HTML_TEMPLATE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Redirect</title></head>
<body>
Redirect successful, this window should close now.
<meta id="ap-oauth-code" content="{{code}}">
<script>
(function () {
    var el = document.getElementById('ap-oauth-code');
    var code = el ? el.getAttribute('content') : null;
    if (window.opener && code) {
        window.opener.postMessage({ code: code }, '*');
    }
})();
</script>
</body>
</html>`