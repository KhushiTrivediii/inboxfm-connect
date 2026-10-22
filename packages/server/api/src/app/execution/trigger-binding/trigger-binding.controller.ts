import { CreateTriggerBindingRequest, Permission, PrincipalType, UpdateTriggerBindingRequest } from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { ProjectResourceType, ProjectTableResource } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { TriggerBindingEntity } from './trigger-binding-entity'
import { triggerBindingService } from './trigger-binding.service'

export const triggerBindingController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post('/', CreateTriggerBindingRouteOptions, async (request, reply) => {
        const projectId = request.projectId
        const platformId = request.principal.platform.id
        const binding = await triggerBindingService.create({
            request: request.body,
            projectId,
            platformId,
        })
        return reply.status(StatusCodes.CREATED).send(binding)
    })

    fastify.get('/', ListTriggerBindingsRouteOptions, async (request) => {
        const projectId = request.projectId
        const platformId = request.principal.platform.id
        return triggerBindingService.list({
            projectId,
            platformId,
        })
    })

    fastify.get('/:id', GetTriggerBindingRouteOptions, async (request) => {
        const projectId = request.projectId
        const platformId = request.principal.platform.id
        return triggerBindingService.getOneOrThrow({
            id: request.params.id,
            projectId,
            platformId,
        })
    })

    fastify.post('/:id', UpdateTriggerBindingRouteOptions, async (request) => {
        const projectId = request.projectId
        const platformId = request.principal.platform.id
        return triggerBindingService.update({
            id: request.params.id,
            projectId,
            platformId,
            request: request.body,
        })
    })

    fastify.delete('/:id', DeleteTriggerBindingRouteOptions, async (request, reply) => {
        const projectId = request.projectId
        const platformId = request.principal.platform.id
        await triggerBindingService.delete({
            id: request.params.id,
            projectId,
            platformId,
        })
        return reply.status(StatusCodes.NO_CONTENT).send()
    })

    fastify.post('/:id/enable', EnableTriggerBindingRouteOptions, async (request) => {
        const projectId = request.projectId
        const platformId = request.principal.platform.id
        return triggerBindingService.enable({
            id: request.params.id,
            projectId,
            platformId,
        })
    })

    fastify.post('/:id/disable', DisableTriggerBindingRouteOptions, async (request) => {
        const projectId = request.projectId
        const platformId = request.principal.platform.id
        return triggerBindingService.disable({
            id: request.params.id,
            projectId,
            platformId,
        })
    })

    fastify.post('/:id/renew', RenewTriggerBindingRouteOptions, async (request) => {
        const projectId = request.projectId
        const platformId = request.principal.platform.id
        return triggerBindingService.renew({
            id: request.params.id,
            projectId,
            platformId,
        })
    })

    /**
     * Public webhook-style event ingress (see `RunTriggerBindingRouteOptions`).
     * No tenant value is forwarded from the request — `executeRun` resolves the
     * binding by id and reads `projectId`/`platformId` off that row, so an ingress
     * caller cannot aim the resulting execution at a project it does not own.
     */
    fastify.post('/:id/run', RunTriggerBindingRouteOptions, async (request) => {
        return triggerBindingService.executeRun({
            id: request.params.id,
            triggerPayload: request.body,
        })
    })
}

/**
 * Every `/:id` route exposes `:id`, never `:projectId`, so ProjectResourceType.PARAM
 * resolved `undefined` and rejected all USER principals. TABLE derives the tenant
 * from the trigger_binding row, so ownership is never client-supplied.
 */
const TriggerBindingProjectResource: ProjectTableResource = {
    type: ProjectResourceType.TABLE,
    tableName: TriggerBindingEntity,
}

const CreateTriggerBindingRouteOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_RUN,
            { type: ProjectResourceType.BODY },
        ),
    },
    schema: {
        body: CreateTriggerBindingRequest,
    },
}

const ListTriggerBindingsRouteOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.READ_RUN,
            { type: ProjectResourceType.QUERY },
        ),
    },
}

const GetTriggerBindingRouteOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.READ_RUN,
            TriggerBindingProjectResource,
        ),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
    },
}

const UpdateTriggerBindingRouteOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_RUN,
            TriggerBindingProjectResource,
        ),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
        body: UpdateTriggerBindingRequest,
    },
}

const DeleteTriggerBindingRouteOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_RUN,
            TriggerBindingProjectResource,
        ),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
    },
}

const EnableTriggerBindingRouteOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_RUN,
            TriggerBindingProjectResource,
        ),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
    },
}

const DisableTriggerBindingRouteOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_RUN,
            TriggerBindingProjectResource,
        ),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
    },
}

const RenewTriggerBindingRouteOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_RUN,
            TriggerBindingProjectResource,
        ),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
    },
}

/**
 * Intentionally public: this is the event-ingress surface a third-party app posts to
 * when the subscribed resource changes (TRIGGER_ARCHITECTURE.md "RUN", and the
 * `webhookUrl` handed to the engine's ON_ENABLE hook). External senders hold no
 * Inboxfm credential, so the unguessable `apId()` in the path is the capability.
 *
 * The schema exposes `:id` and an opaque payload body only — there is deliberately
 * no `projectId` in the params, query or body for a caller to influence. The console
 * also calls this route for "Run / Test" with its bearer token, which the public
 * config simply ignores.
 *
 * Body limit of 1MB: an unauthenticated caller can otherwise exhaust memory or
 * trigger costly LLM executions with a single oversized request (issue #351).
 * Fastify only honors bodyLimit as a TOP-LEVEL route option — nesting it in
 * `config` is silently ignored, and the app-level default (server.ts) is
 * max(file-size, flow-run-log, 25)MB, so without this the public ingress
 * accepts 25MB+ bodies.
 */
const RunTriggerBindingRouteOptions = {
    bodyLimit: 1024 * 1024,
    config: {
        security: securityAccess.public(),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
        body: z.unknown().optional(),
    },
}
