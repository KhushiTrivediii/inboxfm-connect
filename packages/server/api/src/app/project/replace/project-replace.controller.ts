import { ConnectionMappingSchema, Permission, PlatformRole, PrincipalType, ProjectReplaceApplyRequest, ProjectStateSnapshot, ProviderMappingSchema } from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { userService } from '../../user/user-service'
import { projectReplaceService } from './project-replace.service'

const ProjectParamsSchema = z.object({
    projectId: z.string(),
})

const PlanBodySchema = z.union([
    ProjectStateSnapshot,
    z.object({
        snapshot: ProjectStateSnapshot,
        connectionMappings: z.array(ConnectionMappingSchema).optional(),
        providerMappings: z.array(ProviderMappingSchema).optional(),
    }),
])

export const projectReplaceController: FastifyPluginAsyncZod = async (fastify) => {
    // 1. Export source project state snapshot (schema-only, zero secrets/tokens)
    fastify.get('/export', {
        schema: {
            params: ProjectParamsSchema,
        },
        config: {
            security: securityAccess.project(
                [PrincipalType.USER, PrincipalType.SERVICE],
                Permission.READ_PROJECT,
                { type: ProjectResourceType.PARAM },
            ),
        },
    }, async (request) => {
        const projectId = request.params.projectId
        const platformId = request.principal.platform.id
        return projectReplaceService(request.log).exportSnapshot({ projectId, platformId })
    })

    // 2. Generate reviewable plan artifact (preflight + deterministic diff + signing, zero writes)
    fastify.post('/plan', {
        schema: {
            params: ProjectParamsSchema,
            body: PlanBodySchema,
        },
        config: {
            security: securityAccess.project(
                [PrincipalType.USER, PrincipalType.SERVICE],
                Permission.READ_PROJECT,
                { type: ProjectResourceType.PARAM },
            ),
        },
    }, async (request, reply) => {
        const projectId = request.params.projectId
        const platformId = request.principal.platform.id
        const snapshot = 'snapshot' in request.body ? request.body.snapshot : request.body
        const connectionMappings = 'connectionMappings' in request.body ? request.body.connectionMappings : undefined
        const providerMappings = 'providerMappings' in request.body ? request.body.providerMappings : undefined

        const plan = await projectReplaceService(request.log).createPlan({
            targetProjectId: projectId,
            targetPlatformId: platformId,
            snapshot,
            connectionMappings,
            providerMappings,
        })
        const statusCode = plan.preflight.passed ? StatusCodes.OK : StatusCodes.BAD_REQUEST
        return reply.status(statusCode).send({
            artifactVersion: 1,
            toolVersion: plan.toolVersion,
            createdAt: plan.createdAt,
            snapshot,
            plan,
        })
    })

    // 3. Inspect-only endpoint (zero mutations, accessible with READ_PROJECT permission)
    fastify.post('/inspect', {
        schema: {
            params: ProjectParamsSchema,
            body: z.object({
                plan: ProjectReplaceApplyRequest.shape.plan,
                snapshot: ProjectStateSnapshot,
                connectionMappings: z.array(ConnectionMappingSchema).optional(),
            }),
        },
        config: {
            security: securityAccess.project(
                [PrincipalType.USER, PrincipalType.SERVICE],
                Permission.READ_PROJECT,
                { type: ProjectResourceType.PARAM },
            ),
        },
    }, async (request, reply) => {
        const projectId = request.params.projectId
        const platformId = request.principal.platform.id
        const result = await projectReplaceService(request.log).applyPlan({
            targetProjectId: projectId,
            targetPlatformId: platformId,
            request: {
                plan: request.body.plan,
                snapshot: request.body.snapshot,
                dryRun: false,
                force: false,
                inspectOnly: true,
                connectionMappings: request.body.connectionMappings,
            },
            snapshot: request.body.snapshot,
        })
        return reply.status(StatusCodes.OK).send(result)
    })

    // 4. Apply reviewed plan artifact (validates signature, checks drift, applies ordered mutations)
    fastify.post('/apply', {
        schema: {
            params: ProjectParamsSchema,
            body: z.object({
                plan: ProjectReplaceApplyRequest.shape.plan,
                snapshot: ProjectStateSnapshot,
                dryRun: z.boolean().optional(),
                force: z.boolean().optional(),
                deployCustomIntegrations: z.boolean().optional(),
                inspectOnly: z.boolean().optional(),
                connectionMappings: z.array(ConnectionMappingSchema).optional(),
                providerMappings: z.array(ProviderMappingSchema).optional(),
                rotateMcpToken: z.boolean().optional(),
            }),
        },
        config: {
            security: securityAccess.project(
                [PrincipalType.USER, PrincipalType.SERVICE],
                Permission.WRITE_PROJECT,
                { type: ProjectResourceType.PARAM },
            ),
        },
    }, async (request, reply) => {
        const projectId = request.params.projectId
        const platformId = request.principal.platform.id

        if (request.body.deployCustomIntegrations) {
            if (request.principal.type === PrincipalType.USER) {
                const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
                if (user.platformRole !== PlatformRole.ADMIN) {
                    return reply.status(StatusCodes.FORBIDDEN).send({
                        code: 'PERMISSION_DENIED',
                        message: 'Deploying custom integrations platform-wide requires platform administrator permissions.',
                    })
                }
            }
        }

        const result = await projectReplaceService(request.log).applyPlan({
            targetProjectId: projectId,
            targetPlatformId: platformId,
            request: {
                plan: request.body.plan,
                snapshot: request.body.snapshot,
                dryRun: request.body.dryRun,
                force: request.body.force,
                deployCustomIntegrations: request.body.deployCustomIntegrations,
                inspectOnly: request.body.inspectOnly,
                connectionMappings: request.body.connectionMappings,
                providerMappings: request.body.providerMappings,
                rotateMcpToken: request.body.rotateMcpToken,
            },
            snapshot: request.body.snapshot,
        })
        const statusCode = result.failed.length > 0 ? StatusCodes.MULTI_STATUS : StatusCodes.OK
        return reply.status(statusCode).send(result)
    })

    // 5. Combined replace endpoint (direct live or dry-run replace)
    fastify.post('/', {
        schema: {
            params: ProjectParamsSchema,
            body: z.object({
                snapshot: ProjectStateSnapshot,
                dryRun: z.boolean().optional(),
                force: z.boolean().optional(),
                deployCustomIntegrations: z.boolean().optional(),
                inspectOnly: z.boolean().optional(),
                connectionMappings: z.array(ConnectionMappingSchema).optional(),
                providerMappings: z.array(ProviderMappingSchema).optional(),
                rotateMcpToken: z.boolean().optional(),
            }),
        },
        config: {
            security: securityAccess.project(
                [PrincipalType.USER, PrincipalType.SERVICE],
                Permission.WRITE_PROJECT,
                { type: ProjectResourceType.PARAM },
            ),
        },
    }, async (request, reply) => {
        const projectId = request.params.projectId
        const platformId = request.principal.platform.id
        const service = projectReplaceService(request.log)

        if (request.body.deployCustomIntegrations) {
            if (request.principal.type === PrincipalType.USER) {
                const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
                if (user.platformRole !== PlatformRole.ADMIN) {
                    return reply.status(StatusCodes.FORBIDDEN).send({
                        code: 'PERMISSION_DENIED',
                        message: 'Deploying custom integrations platform-wide requires platform administrator permissions.',
                    })
                }
            }
        }

        const plan = await service.createPlan({
            targetProjectId: projectId,
            targetPlatformId: platformId,
            snapshot: request.body.snapshot,
            connectionMappings: request.body.connectionMappings,
            providerMappings: request.body.providerMappings,
        })

        if (!plan.preflight.passed && !request.body.force) {
            return reply.status(StatusCodes.BAD_REQUEST).send({
                error: 'PREFLIGHT_FAILED',
                plan,
            })
        }

        if (request.body.dryRun) {
            return reply.status(StatusCodes.OK).send({
                dryRun: true,
                artifactVersion: 1,
                toolVersion: plan.toolVersion,
                createdAt: plan.createdAt,
                snapshot: request.body.snapshot,
                plan,
            })
        }

        const result = await service.applyPlan({
            targetProjectId: projectId,
            targetPlatformId: platformId,
            request: {
                plan,
                snapshot: request.body.snapshot,
                dryRun: false,
                force: request.body.force,
                deployCustomIntegrations: request.body.deployCustomIntegrations,
                inspectOnly: request.body.inspectOnly,
                connectionMappings: request.body.connectionMappings,
                providerMappings: request.body.providerMappings,
                rotateMcpToken: request.body.rotateMcpToken,
            },
            snapshot: request.body.snapshot,
        })

        const statusCode = result.failed.length > 0 ? StatusCodes.MULTI_STATUS : StatusCodes.OK
        return reply.status(statusCode).send(result)
    })
}
