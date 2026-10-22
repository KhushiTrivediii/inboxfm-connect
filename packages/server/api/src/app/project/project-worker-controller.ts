import { ActivepiecesError, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { projectService } from './project-service'

export const projectWorkerController: FastifyPluginAsyncZod = async (
    app,
) => {
    app.get('/', GetWorkerProjectRequest, async (req) => {
        const projectId = req.principal.projectId
        if (isNil(projectId)) {
            throw new ActivepiecesError({
                code: ErrorCode.AUTHORIZATION,
                params: {
                    message: 'Engine is not allowed to access this project',
                },
            })
        }
        return projectService(req.log).getOneOrThrow(projectId)
    })
}

const GetWorkerProjectRequest = {
    config: {
        security: securityAccess.engine(),
    },
}
