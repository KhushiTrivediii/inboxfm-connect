import { ActivepiecesError, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { CreateExecutionRequestBody, Execution, ExecutionEvent, ListExecutionsRequestQuery, Permission, PrincipalType, ToolCall } from '@inboxfm-connect/shared'
import { FastifyReply } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { ProjectResourceType, ProjectTableResource } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { syncExecutionRateLimitOptions } from '../core/security/rate-limit'
import { securityHelper } from '../helper/security-helper'
import { ExecutionEntity } from './execution-entity'
import { executionEventService } from './execution-event.service'
import { executionService } from './execution.service'
import { toolCallService } from './tool-call/tool-call.service'

export const executionController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post('/', CreateExecutionOptions, async (request, reply) => {
        const userId = await securityHelper.getUserIdFromRequest(request)
        const projectId = request.projectId || request.body.projectId
        if (!projectId) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: { message: 'projectId is required' },
            })
        }

        const execution = await executionService.create({
            projectId,
            platformId: request.principal.platform.id,
            userId,
            prompt: request.body.prompt,
            metadata: request.body.metadata,
        })

        return reply.status(StatusCodes.CREATED).send(execution)
    })

    fastify.get('/:id', GetExecutionOptions, async (request) => {
        return executionService.getOne({
            id: request.params.id,
            projectId: request.projectId,
        })
    })

    fastify.get('/:id/tool-calls', ListToolCallsOptions, async (request) => {
        return toolCallService.listForExecution({
            executionId: request.params.id,
            projectId: request.projectId,
        })
    })

    fastify.get('/:id/events', GetExecutionEventsOptions, async (request, reply) => {
        const executionId = request.params.id
        await executionService.getOne({
            id: executionId,
            projectId: request.projectId,
        })

        // Native EventSource auto-reconnect sends this header with the last `id:` frame
        // it received; a manual/fetch-based SSE client can't set headers on the browser's
        // own reconnect, so the query param is the fallback for those callers.
        const lastEventId = firstHeaderValue(request.headers['last-event-id']) ?? request.query.lastEventId ?? null

        reply.raw.writeHead(StatusCodes.OK, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        })

        const { replayedCount, listener } = await streamResumableExecutionEvents({ executionId, lastEventId, reply })

        request.log.info({
            execution: { id: executionId },
            lastEventId,
            replayedCount,
        }, '[executionController] SSE client (re)connected')

        request.raw.on('close', () => {
            executionEventService.unsubscribe({ executionId, listener }).catch(() => {})
        })

        return reply
    })

    fastify.get('/', ListExecutionsOptions, async (request) => {
        return executionService.list({
            projectId: request.projectId,
            status: request.query.status,
            limit: request.query.limit,
            cursor: request.query.cursor,
        })
    })
}

/**
 * Resumable SSE replay for churn (app restart/scale-down mid-stream, client-side network
 * blip). `subscribe()` is registered before the history read so nothing published in that
 * async gap is lost; live events are buffered (not written) until history replay finishes,
 * then flushed in order. `writeEvent`'s monotonic sequence guard makes the whole thing
 * idempotent against the unavoidable overlap between "already in history" and "arrived live
 * during replay" — every event still reaches the client exactly once, in order.
 */
async function streamResumableExecutionEvents({
    executionId,
    lastEventId,
    reply,
}: {
    executionId: string
    lastEventId: string | null
    reply: FastifyReply
}): Promise<{ replayedCount: number, listener: (event: ExecutionEvent) => void }> {
    let highWaterSeq = executionEventService.parseSequenceFromId({ eventId: lastEventId }) ?? 0
    let isReplayingHistory = true
    const bufferedLiveEvents: ExecutionEvent[] = []

    const writeEvent = (event: ExecutionEvent): void => {
        if (reply.raw.writableEnded || reply.raw.destroyed) {
            return
        }
        const seq = executionEventService.parseSequenceFromId({ eventId: event.id })
        if (isNil(seq) || seq <= highWaterSeq) {
            return
        }
        highWaterSeq = seq
        reply.raw.write(`id: ${event.id}\n`)
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    const listener = (event: ExecutionEvent): void => {
        if (isReplayingHistory) {
            bufferedLiveEvents.push(event)
            return
        }
        writeEvent(event)
    }

    await executionEventService.subscribe({
        executionId,
        listener,
    })

    const history = await executionEventService.getEventsSince({ executionId, lastEventId })
    for (const event of history) {
        writeEvent(event)
    }

    isReplayingHistory = false
    const orderedBufferedEvents = [...bufferedLiveEvents].sort((a, b) => {
        const seqA = executionEventService.parseSequenceFromId({ eventId: a.id }) ?? 0
        const seqB = executionEventService.parseSequenceFromId({ eventId: b.id }) ?? 0
        return seqA - seqB
    })
    for (const event of orderedBufferedEvents) {
        writeEvent(event)
    }

    return { replayedCount: history.length, listener }
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
    if (isNil(value)) {
        return null
    }
    return Array.isArray(value) ? (value[0] ?? null) : value
}

const GetExecutionParams = z.object({
    id: z.string(),
})

/**
 * `/:id` routes must derive the tenant from the execution row itself.
 * ProjectResourceType.PARAM reads `request.params.projectId`, which these routes
 * never expose (the route param is `:id`), so every USER principal was rejected
 * with "Project ID is required". TABLE resolves projectId from ExecutionEntity —
 * the same pattern connections/tables/records use — so ownership can never be
 * supplied by the client.
 */
const ExecutionProjectResource: ProjectTableResource = {
    type: ProjectResourceType.TABLE,
    tableName: ExecutionEntity,
}

const CreateExecutionOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE],
            Permission.WRITE_RUN,
            { type: ProjectResourceType.BODY },
        ),
        rateLimit: syncExecutionRateLimitOptions,
    },
    schema: {
        tags: ['executions'],
        body: CreateExecutionRequestBody,
        response: {
            [StatusCodes.CREATED]: Execution,
        },
    },
}

const GetExecutionOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE],
            Permission.READ_RUN,
            ExecutionProjectResource,
        ),
    },
    schema: {
        tags: ['executions'],
        params: GetExecutionParams,
        response: {
            [StatusCodes.OK]: Execution,
        },
    },
}

const ListToolCallsOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE],
            Permission.READ_RUN,
            ExecutionProjectResource,
        ),
    },
    schema: {
        tags: ['executions'],
        params: GetExecutionParams,
        response: {
            [StatusCodes.OK]: z.array(ToolCall),
        },
    },
}

const GetExecutionEventsOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE],
            Permission.READ_RUN,
            ExecutionProjectResource,
        ),
    },
    schema: {
        tags: ['executions'],
        params: GetExecutionParams,
        querystring: z.object({
            lastEventId: z.string().optional(),
        }),
    },
}

const ListExecutionsOptions = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE],
            Permission.READ_RUN,
            { type: ProjectResourceType.QUERY },
        ),
        rateLimit: syncExecutionRateLimitOptions,
    },
    schema: {
        tags: ['executions'],
        querystring: ListExecutionsRequestQuery,
        response: {
            [StatusCodes.OK]: z.object({
                data: z.array(Execution),
                next: z.string().nullable(),
                previous: z.string().nullable(),
            }),
        },
    },
}

