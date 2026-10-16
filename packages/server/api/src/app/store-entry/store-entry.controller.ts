import { ActivepiecesError, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import {
    DeleteStoreEntryRequest,
    GetStoreEntryRequest,
    PutStoreEntryRequest,
    STORE_VALUE_MAX_SIZE,
} from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import sizeof from 'object-sizeof'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { storeEntryService } from './store-entry.service'

export const storeEntryController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post( '/', CreateRequest, async (request, reply) => {
        const sizeOfValue = sizeof(request.body.value)
        if (sizeOfValue > STORE_VALUE_MAX_SIZE) {
            await reply.status(StatusCodes.REQUEST_TOO_LONG).send({})
            return
        }
        const response = await storeEntryService.upsert({
            projectId: requireEngineProjectId({ projectId: request.principal.projectId }),
            request: request.body,
        })
        await reply.status(StatusCodes.OK).send(response)
    },
    )

    fastify.get('/', GetRequest, async (request) => {
        const value = await storeEntryService.getOne({
            projectId: requireEngineProjectId({ projectId: request.principal.projectId }),
            key: request.query.key,
        })

        if (isNil(value)) {
            // Every other miss on the API answers with the structured error
            // contract ({ code, params }); a raw text body breaks JSON clients
            // (the engine's store client tolerates it only because it checks the
            // status code before parsing).
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'storeEntry',
                    entityId: request.query.key,
                },
            })
        }

        return value
    },
    )

    fastify.delete('/', DeleteStoreRequest, async (request) => {
        return storeEntryService.delete({
            projectId: requireEngineProjectId({ projectId: request.principal.projectId }),
            key: request.query.key,
        })
    },
    )
}

const requireEngineProjectId = ({ projectId }: { projectId: string | undefined }) => {
    if (isNil(projectId)) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'Engine is not allowed to access this project',
            },
        })
    }
    return projectId
}

const CreateRequest =  {
    config: {
        security: securityAccess.engine(),
    },
    schema: {
        body: PutStoreEntryRequest,
    },
}

const GetRequest = {
    config: {
        security: securityAccess.engine(),
    },
    schema: {
        querystring: GetStoreEntryRequest,
    },
}


const DeleteStoreRequest = {
    config: {
        security: securityAccess.engine(),
    },
    schema: {
        querystring: DeleteStoreEntryRequest,
    },
}