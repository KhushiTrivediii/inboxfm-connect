import { ActivepiecesError, apId, assertNotNullOrUndefined, ErrorCode, isNil, spreadIfDefined } from '@inboxfm-connect/core-utils'
import { CreateFieldRequest, Field, FieldState, FieldType, UpdateFieldRequest } from '@inboxfm-connect/shared'
import { In, Repository } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { transaction } from '../../core/db/transaction'
import { distributedLock } from '../../database/redis-connections'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { FieldEntity } from './field.entity'

const fieldRepo = repoFactory<Field>(FieldEntity)

// Field order is a dense, 0-indexed integer per table (0..count-1), enforced by a
// DEFERRABLE INITIALLY DEFERRED unique constraint on (tableId, position) - see the
// AddPositionToField migration. Dense integers were chosen over fractional/sparse
// positions because AP_MAX_FIELDS_PER_TABLE caps a table at 100 fields, so an
// insert-between's O(n) shift is cheap, and dense integers avoid the precision decay
// and periodic re-normalization that fractional positions need after many reorders.
//
// Every create/reorder/delete that touches positions runs inside a per-table
// `distributedLock` (Redis, serializes writers across API replicas) wrapping a single
// DB transaction. The lock is the primary defense - it makes the shift-then-write
// sequence appear atomic to every other caller. The deferred unique constraint is the
// secondary, DB-level defense: because it is checked at COMMIT rather than per-row, a
// transaction is free to transit through positions another row still holds while it
// shifts a block of siblings, and Postgres still has the final word if the lock is
// ever unavailable (e.g. Redis outage) or the shift math is wrong.
const FIELD_POSITION_LOCK_TIMEOUT_SECONDS = 30

export const fieldService = {
    async create({ request, projectId }: CreateParams): Promise<Field> {
        await this.validateCount({ projectId, tableId: request.tableId })
        return distributedLock(system.globalLogger()).runExclusive({
            key: fieldPositionLockKey(request.tableId),
            timeoutInSeconds: FIELD_POSITION_LOCK_TIMEOUT_SECONDS,
            fn: () => transaction(async (entityManager) => {
                const repo = fieldRepo(entityManager)
                const siblingCount = await repo.count({ where: { projectId, tableId: request.tableId } })
                const targetPosition = clampPosition({ position: request.position ?? siblingCount, max: siblingCount })
                await shiftPositionsForInsert({ repo, projectId, tableId: request.tableId, fromPosition: targetPosition })
                return repo.save({
                    ...request,
                    projectId,
                    id: apId(),
                    externalId: request.externalId ?? apId(),
                    position: targetPosition,
                })
            }),
        })
    },

    async createFromState({ projectId, field, tableId }: CreateFromStateParams): Promise<Field> {
        switch (field.type) {
            case FieldType.STATIC_DROPDOWN: {
                assertNotNullOrUndefined(field.data, 'Data is required for static dropdown field')
                return this.create({
                    projectId,
                    request: {
                        name: field.name,
                        type: field.type,
                        tableId,
                        data: field.data as { options: { value: string }[] },
                        externalId: field.externalId,
                    },
                })
            }
            case FieldType.DATE:
            case FieldType.NUMBER:
            case FieldType.TEXT: {
                return this.create({
                    projectId,
                    request: {
                        name: field.name,
                        type: field.type,
                        tableId,
                        externalId: field.externalId,
                    },
                })
            }
            default: {
                throw new ActivepiecesError({
                    code: ErrorCode.VALIDATION,
                    params: {
                        message: `Unsupported field type: ${field.type}`,
                    },
                })
            }
        }
    },

    async getAll({ projectId, tableId }: GetAllParams): Promise<Field[]> {
        return fieldRepo().find({
            where: { projectId, tableId },
            order: {
                position: 'ASC',
            },
        })
    },

    async getAllByTableIds({ projectId, tableIds }: GetAllByTableIdsParams): Promise<Map<string, Field[]>> {
        const result = new Map<string, Field[]>()
        if (isNil(tableIds) || tableIds.length === 0) {
            return result
        }

        const fields = await fieldRepo().find({
            where: { projectId, tableId: In(tableIds) },
            order: {
                position: 'ASC',
            },
        })
        for (const tableId of tableIds) {
            result.set(tableId, [])
        }
        for (const field of fields) {
            result.get(field.tableId)?.push(field)
        }
        return result
    },

    async getById({ id, projectId }: GetByIdParams): Promise<Field> {
        const field = await fieldRepo().findOne({
            where: { id, projectId },
        })

        if (isNil(field)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'Field',
                    entityId: id,
                },
            })
        }

        return field
    },

    async delete({ id, projectId }: DeleteParams): Promise<void> {
        const existing = await fieldRepo().findOneBy({ id, projectId })
        if (isNil(existing)) {
            return
        }

        await distributedLock(system.globalLogger()).runExclusive({
            key: fieldPositionLockKey(existing.tableId),
            timeoutInSeconds: FIELD_POSITION_LOCK_TIMEOUT_SECONDS,
            fn: () => transaction(async (entityManager) => {
                const repo = fieldRepo(entityManager)
                const current = await repo.findOneBy({ id, projectId })
                if (isNil(current)) {
                    return
                }
                await repo.delete({ id, projectId })
                await shiftPositionsForDelete({ repo, projectId, tableId: current.tableId, deletedPosition: current.position })
            }),
        })
    },

    async update({ id, projectId, request }: UpdateParams): Promise<Field> {
        const current = await this.getById({ id, projectId })
        const isReorder = !isNil(request.position) && request.position !== current.position
        if (!isReorder) {
            await fieldRepo().update({
                id,
                projectId,
            }, {
                ...spreadIfDefined('name', request.name),
            })
            return this.getById({ id, projectId })
        }

        return distributedLock(system.globalLogger()).runExclusive({
            key: fieldPositionLockKey(current.tableId),
            timeoutInSeconds: FIELD_POSITION_LOCK_TIMEOUT_SECONDS,
            fn: () => transaction(async (entityManager) => {
                const repo = fieldRepo(entityManager)
                const siblingCount = await repo.count({ where: { projectId, tableId: current.tableId } })
                assertNotNullOrUndefined(request.position, 'request.position is required to reorder a field')
                const targetPosition = clampPosition({ position: request.position, max: siblingCount - 1 })
                await shiftPositionsForMove({ repo, projectId, tableId: current.tableId, fromPosition: current.position, toPosition: targetPosition })
                await repo.update({ id, projectId }, {
                    ...spreadIfDefined('name', request.name),
                    position: targetPosition,
                })
                const updated = await repo.findOneBy({ id, projectId })
                if (isNil(updated)) {
                    throw new ActivepiecesError({
                        code: ErrorCode.ENTITY_NOT_FOUND,
                        params: {
                            entityType: 'Field',
                            entityId: id,
                        },
                    })
                }
                return updated
            }),
        })
    },

    async count({ projectId, tableId }: CountParams): Promise<number> {
        return fieldRepo().count({
            where: { projectId, tableId },
        })
    },
    async validateCount(params: CountParams): Promise<void> {
        const countRes = await this.count(params)
        if (countRes + 1 > system.getNumberOrThrow(AppSystemProp.MAX_FIELDS_PER_TABLE)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: { message: `Max fields per table reached: ${system.getNumberOrThrow(AppSystemProp.MAX_FIELDS_PER_TABLE)}`,
                },
            })
        }
    },
}

function fieldPositionLockKey(tableId: string): string {
    return `field-position_${tableId}`
}

function clampPosition({ position, max }: { position: number, max: number }): number {
    const boundedMax = Math.max(max, 0)
    return Math.min(Math.max(Math.trunc(position), 0), boundedMax)
}

async function shiftPositionsForInsert({ repo, projectId, tableId, fromPosition }: ShiftForInsertParams): Promise<void> {
    await repo.createQueryBuilder()
        .update()
        .set({ position: () => '"position" + 1' })
        .where('"projectId" = :projectId AND "tableId" = :tableId AND "position" >= :fromPosition', { projectId, tableId, fromPosition })
        .execute()
}

async function shiftPositionsForDelete({ repo, projectId, tableId, deletedPosition }: ShiftForDeleteParams): Promise<void> {
    await repo.createQueryBuilder()
        .update()
        .set({ position: () => '"position" - 1' })
        .where('"projectId" = :projectId AND "tableId" = :tableId AND "position" > :deletedPosition', { projectId, tableId, deletedPosition })
        .execute()
}

async function shiftPositionsForMove({ repo, projectId, tableId, fromPosition, toPosition }: ShiftForMoveParams): Promise<void> {
    if (toPosition === fromPosition) {
        return
    }
    if (toPosition > fromPosition) {
        await repo.createQueryBuilder()
            .update()
            .set({ position: () => '"position" - 1' })
            .where('"projectId" = :projectId AND "tableId" = :tableId AND "position" > :fromPosition AND "position" <= :toPosition', { projectId, tableId, fromPosition, toPosition })
            .execute()
        return
    }
    await repo.createQueryBuilder()
        .update()
        .set({ position: () => '"position" + 1' })
        .where('"projectId" = :projectId AND "tableId" = :tableId AND "position" >= :toPosition AND "position" < :fromPosition', { projectId, tableId, fromPosition, toPosition })
        .execute()
}

type CreateParams = {
    projectId: string
    request: CreateFieldRequest
}

type CreateFromStateParams = {
    projectId: string
    field: FieldState
    tableId: string
}

type GetAllParams = {
    projectId: string
    tableId: string
}

type GetAllByTableIdsParams = {
    projectId: string
    tableIds: string[]
}

type GetByIdParams = {
    id: string
    projectId: string
}

type DeleteParams = {
    id: string
    projectId: string
}

type UpdateParams = {
    id: string
    projectId: string
    request: UpdateFieldRequest
}

type CountParams = {
    projectId: string
    tableId: string
}

type ShiftForInsertParams = {
    repo: Repository<Field>
    projectId: string
    tableId: string
    fromPosition: number
}

type ShiftForDeleteParams = {
    repo: Repository<Field>
    projectId: string
    tableId: string
    deletedPosition: number
}

type ShiftForMoveParams = {
    repo: Repository<Field>
    projectId: string
    tableId: string
    fromPosition: number
    toPosition: number
}
