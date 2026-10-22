import { PrincipalType } from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { syncExecutionRateLimitOptions } from '../core/security/rate-limit'
import { knowledgeSearchService } from './knowledge-search.service'

export const knowledgeSearchController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post('/query', QueryKnowledgeSearchOptions, async (request, reply) => {
        const platformId = request.principal.platform.id
        const projectId = request.projectId

        const result = await knowledgeSearchService(request.log).query({
            query: request.body.query,
            limit: request.body.limit,
            objectKind: request.body.objectKind,
            pieceName: request.body.pieceName,
            audiences: request.body.audiences,
            platformId,
            projectId,
        })

        return reply.status(StatusCodes.OK).send(result)
    })
}

const KnowledgeSearchQueryRequestBody = z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).optional(),
    objectKind: z.enum(['action', 'trigger', 'all']).optional(),
    pieceName: z.string().optional(),
    audiences: z.array(z.string()).optional(),
})

const KnowledgeSearchResultItemSchema = z.object({
    pieceName: z.string(),
    objectName: z.string(),
    objectKind: z.enum(['action', 'trigger']),
    displayName: z.string(),
    oneLineDescription: z.string().optional(),
    requiresConnection: z.boolean(),
    cosine: z.number().optional(),
    connected: z.boolean().optional(),
})

const KnowledgeSearchQueryResponseBody = z.object({
    results: z.array(KnowledgeSearchResultItemSchema),
    mode: z.enum(['semantic', 'keyword']),
})

const QueryKnowledgeSearchOptions = {
    config: {
        security: securityAccess.publicPlatform([
            PrincipalType.USER,
            PrincipalType.ENGINE,
            PrincipalType.SERVICE,
        ]),
        rateLimit: syncExecutionRateLimitOptions,
    },
    schema: {
        tags: ['knowledge-search'],
        body: KnowledgeSearchQueryRequestBody,
        response: {
            [StatusCodes.OK]: KnowledgeSearchQueryResponseBody,
        },
    },
}
