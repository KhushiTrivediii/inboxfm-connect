import { ActivepiecesError, apId, ErrorCode, isNil, SeekPage } from '@inboxfm-connect/core-utils'
import { Execution, ExecutionEventType, ExecutionStatus, executionUtils, TokenUsage } from '@inboxfm-connect/shared'
import { repoFactory } from '../core/db/repo-factory'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { ExecutionEntity, ExecutionSchema } from './execution-entity'
import { executionEventService } from './execution-event.service'

const executionRepo = repoFactory<ExecutionSchema>(ExecutionEntity)

const executionService = {
    async create({
        projectId,
        platformId,
        userId,
        prompt,
        metadata = {},
    }: {
        projectId: string
        platformId: string
        userId?: string | null
        prompt: string
        metadata?: Record<string, unknown>
    }): Promise<Execution> {
        const newExecution: Execution = {
            id: apId(),
            projectId,
            platformId,
            userId: userId ?? null,
            status: ExecutionStatus.CREATED,
            prompt,
            metadata,
            tokenUsage: null,
            cost: null,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            finishTime: null,
        }

        const saved = await executionRepo().save(newExecution)
        await executionEventService.emit({
            executionId: saved.id,
            type: ExecutionEventType.ExecutionStarted,
            payload: {
                executionId: saved.id,
                prompt: saved.prompt,
                timestamp: saved.created,
            },
        })

        return saved
    },

    async getOne({
        id,
        projectId,
    }: {
        id: string
        projectId: string
    }): Promise<Execution> {
        const execution = await executionRepo().findOneBy({ id, projectId })
        if (isNil(execution)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'Execution',
                    entityId: id,
                },
            })
        }
        return execution
    },

    async updateStatus({
        id,
        projectId,
        status,
        tokenUsage,
        cost,
        finishTime,
    }: {
        id: string
        projectId: string
        status: ExecutionStatus
        tokenUsage?: TokenUsage | null
        cost?: number | null
        finishTime?: string | null
    }): Promise<Execution> {
        const current = await this.getOne({ id, projectId })

        if (!executionUtils.isValidExecutionStatusTransition({ from: current.status, to: status })) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `Invalid execution status transition from ${current.status} to ${status}`,
                },
            })
        }

        const updatedFields = {
            status,
            updated: new Date().toISOString(),
            ...(tokenUsage !== undefined ? { tokenUsage } : {}),
            ...(cost !== undefined ? { cost } : {}),
            ...(finishTime !== undefined ? { finishTime } : {}),
        }

        await executionRepo().update({ id, projectId }, updatedFields)
        const updated = await this.getOne({ id, projectId })

        if (status === ExecutionStatus.COMPLETED) {
            await executionEventService.emit({
                executionId: id,
                type: ExecutionEventType.ExecutionCompleted,
                payload: {
                    executionId: id,
                    totalTokens: tokenUsage?.totalTokens ?? null,
                    finishTime: updated.finishTime,
                },
            })
        }
        else if (status === ExecutionStatus.FAILED) {
            await executionEventService.emit({
                executionId: id,
                type: ExecutionEventType.ExecutionFailed,
                payload: {
                    executionId: id,
                    error: { message: 'Execution failed' },
                },
            })
        }
        else if (status === ExecutionStatus.CANCELLED) {
            await executionEventService.emit({
                executionId: id,
                type: ExecutionEventType.ExecutionCancelled,
                payload: {
                    executionId: id,
                    reason: 'Cancelled by request',
                },
            })
        }

        return updated
    },

    async list({
        projectId,
        status,
        limit = 10,
        cursor,
    }: {
        projectId: string
        status?: ExecutionStatus
        limit?: number
        cursor?: string
    }): Promise<SeekPage<Execution>> {
        const decodedCursor = paginationHelper.decodeCursor(cursor)
        const paginator = buildPaginator({
            entity: ExecutionEntity,
            query: {
                limit,
                order: 'DESC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })

        const query = executionRepo()
            .createQueryBuilder('execution')
            .where('execution.projectId = :projectId', { projectId })

        if (!isNil(status)) {
            query.andWhere('execution.status = :status', { status })
        }

        const { data, cursor: cursorResult } = await paginator.paginate(query)
        return paginationHelper.createPage<Execution>(data, cursorResult)
    },
}

export { executionService }
