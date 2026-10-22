import { ActivepiecesError, apId, chunk, Cursor, ErrorCode, isNil, SeekPage } from '@inboxfm-connect/core-utils'
import { Cell, CreateRecordsRequest, Field, Filter, FilterOperator, PopulatedRecord, TableWebhookEventType, UpdateRecordRequest } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, In, SelectQueryBuilder } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { transaction } from '../../core/db/transaction'
import { distributedLock } from '../../database/redis-connections'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { Order } from '../../helper/pagination/paginator'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { FieldEntity } from '../field/field.entity'
import { fieldService } from '../field/field.service'
import { CellEntity } from './cell.entity'
import { RecordEntity, RecordSchema } from './record.entity'

const MAX_BATCH_SIZE = 50

// Lock acquisition budget for record creates, mirroring the field writer lock.
// Redlock auto-extends while the locked fn runs (distributed-lock-factory), so
// this only bounds acquisition retries, not the insert itself.
const RECORD_INSERT_LOCK_TIMEOUT_SECONDS = 30

// Bounded pagination for record listing (issue #400). MAX_PAGE_SIZE follows the
// piece-metadata pagination convention; the service-level clamp bounds every
// caller (REST querystring, MCP tool, piece sentinel) regardless of upstream
// validation.
const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 500

export function clampRecordListLimit(rawLimit: number | undefined): number {
    // Mirrors the piece-metadata pagination convention: [1, MAX_PAGE_SIZE],
    // falling back to the default when absent or non-numeric (issue #400).
    return Math.max(1, Math.min(Math.floor(rawLimit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE))
}

const recordRepo = repoFactory(RecordEntity)
const cellsRepo = repoFactory(CellEntity)

export const recordService = {
    async create({
        request,
        projectId,
        fields,
    }: CreateParams): Promise<PopulatedRecord[]> {
        const existingFields = fields ?? await fieldService.getAll({
            tableId: request.tableId,
            projectId,
        })

        const validRecords = request.records.map((recordData) =>
            recordData.filter((cellData) =>
                existingFields.some((field) => field.id === cellData.fieldId),
            ),
        )

        // The MAX_RECORDS_PER_TABLE check used to run before the insert
        // transaction, making the quota a check-then-act: two concurrent batch
        // creates both counted below the limit and both inserted, drifting the
        // quota by one racing batch. Serialize the count check with the insert
        // behind a per-table distributedLock - the same writer serialization
        // field.service relies on - so create, the only records insert path,
        // always counts the rows the previous create committed.
        const insertedRecordIds = await distributedLock(system.globalLogger()).runExclusive({
            key: recordInsertLockKey(request.tableId),
            timeoutInSeconds: RECORD_INSERT_LOCK_TIMEOUT_SECONDS,
            fn: async () => {
                await this.validateCount({ projectId, tableId: request.tableId }, request.records.length)
                return transaction(async (entityManager: EntityManager) => {
                    const batches = chunk(validRecords, MAX_BATCH_SIZE)
                    const records: RecordSchema[] = []
                    const insertedRecordIds: string[] = []

                    for (const batch of batches) {
                        const now = new Date(new Date().getTime() + records.length)
                        const recordInsertions = prepareRecordInsertions(batch, request.tableId, projectId, now)
                        await entityManager.getRepository(RecordEntity).insert(recordInsertions)

                        const cellInsertions = prepareCellInsertions(batch, recordInsertions, projectId)
                        await entityManager.getRepository(CellEntity).insert(cellInsertions)

                        insertedRecordIds.push(...recordInsertions.map((r) => r.id))
                    }

                    return insertedRecordIds
                })
            },
        })

        const insertedRecords = await recordRepo().find({
            where: { id: In(insertedRecordIds), tableId: request.tableId, projectId },
            relations: ['cells'],
            order: {
                created: 'ASC',
            },
        })
        return formatRecordsAndFetchField({ records: insertedRecords, tableId: request.tableId, projectId, fields: existingFields })
    },

    async list({
        tableId,
        projectId,
        cursorRequest,
        filters,
        limit,
        fields: prefetchedFields,
    }: ListParams): Promise<SeekPage<PopulatedRecord>> {
        // Clamp first (issue #400): the request contract only coerces
        // (z.coerce.number()), so REST callers can pass any number, and the
        // tables piece sends a 999999999 sentinel for "no limit" - the clamp
        // is the single boundary every caller passes through.
        const boundedLimit = clampRecordListLimit(limit)
        const decodedCursor = paginationHelper.decodeCursor(cursorRequest)

        const paginator = buildPaginator({
            entity: RecordEntity,
            query: {
                limit: boundedLimit,
                order: 'ASC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
                orderBy: [
                    { field: 'created', order: Order.ASC },
                    { field: 'id', order: Order.ASC },
                ],
            },
        })

        const queryBuilder = recordRepo()
            .createQueryBuilder('record')
            .where({
                projectId,
                tableId,
            })

        if (filters && filters.length > 0) {
            for (let i = 0; i < filters.length; i++) {
                applyFilterToQueryBuilder(queryBuilder, filters[i], i)
            }
        }

        const { data: pageRecords, cursor } = await paginator.paginate(queryBuilder)

        if (pageRecords.length === 0) {
            return paginationHelper.createPage([], cursor)
        }

        const fields = prefetchedFields ?? await fieldService.getAll({
            tableId,
            projectId,
        })

        const pageRecordIds = pageRecords.map((r) => r.id)
        const fieldIds = fields.map((f) => f.id)

        const cells = fieldIds.length > 0 && pageRecordIds.length > 0
            ? await cellsRepo().find({
                where: {
                    projectId,
                    fieldId: In(fieldIds),
                    recordId: In(pageRecordIds),
                },
            })
            : []

        const cellsByRecordId = new Map<string, Cell[]>()
        for (const cell of cells) {
            const group = cellsByRecordId.get(cell.recordId)
            if (group) {
                group.push(cell)
            }
            else {
                cellsByRecordId.set(cell.recordId, [cell])
            }
        }
        for (const record of pageRecords) {
            record.cells = cellsByRecordId.get(record.id) ?? []
        }

        const populatedRecords = await formatRecordsAndFetchField({
            records: pageRecords,
            tableId,
            projectId,
            fields,
        })

        return paginationHelper.createPage(populatedRecords, cursor)
    },

    async getById({
        id,
        projectId,
    }: GetByIdParams): Promise<PopulatedRecord> {
        const record = await recordRepo().findOne({
            where: { id, projectId },
            relations: ['cells'],
        })

        if (isNil(record)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'Record',
                    entityId: id,
                },
            })
        }

        const result = await formatRecordsAndFetchField({ records: [record], tableId: record.tableId, projectId: record.projectId })
        return result[0]
    },

    async update({
        id,
        projectId,
        request,
    }: UpdateParams): Promise<PopulatedRecord> {
        const { tableId } = request
        return transaction(async (entityManager: EntityManager) => {
            const record = await entityManager.getRepository(RecordEntity).findOne({
                where: { projectId, tableId, id },
            })

            if (isNil(record)) {
                throw new ActivepiecesError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        entityType: 'Record',
                        entityId: id,
                    },
                })
            }

            if (request.cells && request.cells.length > 0) {
                const existingFields = await entityManager
                    .getRepository(FieldEntity)
                    .find({
                        where: { projectId, tableId },
                    })

                // Filter out cells with non-existing fields
                const validCells = request.cells.filter((cellData) =>
                    existingFields.some((field) => field.id === cellData.fieldId),
                )

                // Prepare cells for upsert
                const cellsToUpsert = validCells.map((cellData) => {
                    return {
                        recordId: id,
                        fieldId: cellData.fieldId,
                        projectId,
                        value: cellData.value ?? '',
                        id: apId(),
                    }
                })

                // Perform bulk upsert only for valid cells
                if (cellsToUpsert.length > 0) {
                    await entityManager
                        .getRepository(CellEntity)
                        .upsert(cellsToUpsert, ['projectId', 'fieldId', 'recordId'])
                }
            }

            // Fetch and return the updated record with full details
            const updatedRecord = await entityManager
                .getRepository(RecordEntity)
                .findOne({
                    where: { id, projectId, tableId },
                    relations: ['cells'],
                })

            if (isNil(updatedRecord)) {
                throw new ActivepiecesError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        entityType: 'Record',
                        entityId: id,
                    },
                })
            }

            const result = await formatRecordsAndFetchField({ records: [updatedRecord], tableId: updatedRecord.tableId, projectId: updatedRecord.projectId })
            return result[0]
        })
    },

    async delete({
        ids,
        projectId,
        tableId,
    }: DeleteParams): Promise<PopulatedRecord[]> {
        if (isNil(ids) || ids.length === 0) {
            return []
        }

        // A caller-declared tableId (the REST DeleteRecordsRequest contract
        // carries one) pins the whole batch to that table, so the delete target
        // always matches the table the security middleware resolved the
        // permission from. When absent (MCP ap_delete_records passes bare ids
        // collected via ap_find_records, which is single-table per call), the
        // batch can span tables: resolve every record and group by its actual
        // table instead of scoping the whole batch to ids[0]'s table, which
        // silently dropped rows belonging to any other table.
        const records = await recordRepo().find({
            where: isNil(tableId) ? { id: In(ids), projectId } : { id: In(ids), projectId, tableId },
            relations: ['cells'],
        })

        if (records.length === 0) {
            return []
        }

        const recordsByTable = new Map<string, RecordSchema[]>()
        for (const record of records) {
            const existing = recordsByTable.get(record.tableId) ?? []
            existing.push(record)
            recordsByTable.set(record.tableId, existing)
        }

        // One transaction for the whole batch: a failure partway through must
        // not leave the caller with a partially deleted batch.
        await transaction(async (entityManager) => {
            const repo = recordRepo(entityManager)
            for (const [recordTableId, tableRecords] of recordsByTable) {
                await repo.delete({
                    id: In(tableRecords.map((record) => record.id)),
                    projectId,
                    tableId: recordTableId,
                })
            }
        })

        // Fields must be resolved per table: formatting a mixed batch against a
        // single table's fields would label every other table's cells with the
        // wrong field names and miss their fields entirely.
        const fieldsByTable = await fieldService.getAllByTableIds({
            projectId,
            tableIds: [...recordsByTable.keys()],
        })
        const populatedRecords: PopulatedRecord[] = []
        for (const [recordTableId, tableRecords] of recordsByTable) {
            populatedRecords.push(...formatRecords(tableRecords, fieldsByTable.get(recordTableId) ?? []))
        }
        return populatedRecords
    },

    async deleteAll({
        tableId,
        projectId,
    }: DeleteAllParams): Promise<PopulatedRecord[]> {
        const deletedRecords = await transaction(async (entityManager: EntityManager) => {
            const records = await entityManager.getRepository(RecordEntity).find({
                where: { projectId, tableId },
                relations: ['cells'],
            })

            const recordIds = records.map((record) => record.id)

            if (recordIds.length > 0) {
                await entityManager.getRepository(RecordEntity).delete({
                    id: In(recordIds),
                    projectId,
                    tableId,
                })
            }

            return records
        })

        if (deletedRecords.length === 0) {
            return []
        }

        return formatRecordsAndFetchField({ records: deletedRecords, tableId, projectId })
    },

    async triggerWebhooks({
        projectId: _projectId,
        tableId: _tableId,
        eventType: _eventType,
        data: _data,
        logger: _logger,
        authorization: _authorization,
    }: TriggerWebhooksParams): Promise<void> {
        // No-op: Flow table webhooks are deprecated in headless platform.
    },

    async count({ projectId, tableId }: CountParams): Promise<number> {
        return recordRepo().count({
            where: { projectId, tableId },
        })
    },
    async validateCount(params: CountParams, insertCount: number): Promise<void> {
        const countRes = await this.count(params)
        if (countRes + insertCount > system.getNumberOrThrow(AppSystemProp.MAX_RECORDS_PER_TABLE)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `Max records per table reached: ${system.getNumberOrThrow(AppSystemProp.MAX_RECORDS_PER_TABLE)}`,
                },
            })
        }
    },
}

type CreateParams = {
    request: CreateRecordsRequest
    projectId: string
    logger: FastifyBaseLogger
    fields?: Field[]
}

type ListParams = {
    tableId: string
    projectId: string
    cursorRequest: Cursor | null
    limit: number
    filters: Filter[] | null
    fields?: Field[]
}

type GetByIdParams = {
    id: string
    projectId: string
}

type UpdateParams = {
    id: string
    projectId: string
    request: UpdateRecordRequest
}

type DeleteParams = {
    ids: string[]
    projectId: string
    tableId?: string
}

type DeleteAllParams = {
    tableId: string
    projectId: string
}

type TriggerWebhooksParams = {
    projectId: string
    tableId: string
    eventType: TableWebhookEventType
    data: Record<string, unknown>
    logger: FastifyBaseLogger
    authorization: string
}
type CountParams = {
    projectId: string
    tableId: string
}

type RecordInsertion = {
    id: string
    tableId: string
    projectId: string
    created: string
}

type CellInsertion = {
    id: string
    recordId: string
    fieldId: string
    projectId: string
    value: string
}

function recordInsertLockKey(tableId: string): string {
    return `record-insert_${tableId}`
}

function prepareRecordInsertions(
    records: Array<Array<{ fieldId: string, value: string | null }>>,
    tableId: string,
    projectId: string,
    baseDate: Date,
): RecordInsertion[] {
    return records.map((_, index) => {
        const created = new Date(baseDate.getTime() + index).toISOString()
        return {
            tableId,
            projectId,
            created,
            id: apId(),
        }
    })
}

function prepareCellInsertions(
    records: Array<Array<{ fieldId: string, value: string | null }>>,
    recordInsertions: RecordInsertion[],
    projectId: string,
): CellInsertion[] {
    return records.flatMap((recordData, index) =>
        recordData.map((cellData) => {
            return {
                recordId: recordInsertions[index].id,
                fieldId: cellData.fieldId,
                projectId,
                value: cellData.value ?? '',
                id: apId(),
            }
        }),
    )
}

async function formatRecordsAndFetchField({ records, tableId, projectId, fields: prefetchedFields }: { records: RecordSchema[], tableId: string, projectId: string, fields?: Field[] }): Promise<PopulatedRecord[]> {
    const fields = prefetchedFields ?? await fieldService.getAll({
        tableId,
        projectId,
    })
    return formatRecords(records, fields)
}

function formatRecords(records: RecordSchema[], fields: Field[]): PopulatedRecord[] {
    const fieldsNamesMap: Record<string, string> = fields.reduce((acc, field) => {
        acc[field.id] = field.name
        return acc
    }, {} as Record<string, string>)
    return records.map((record) => {
        const cells = record.cells.reduce<PopulatedRecord['cells']>((acc, cell) => {
            acc[cell.fieldId] = {
                fieldName: fieldsNamesMap[cell.fieldId],
                value: cell.value,
                updated: cell.updated,
                created: cell.created,
            }
            return acc
        }, {})
        for (const field of fields) {
            if (!(field.id in cells)) {
                cells[field.id] = {
                    fieldName: field.name,
                    value: null,
                    updated: record.updated,
                    created: record.created,
                }
            }
        }
        return {
            ...record,
            cells,
        }
    })
}


const STRICT_NUMERIC_FILTER_REGEX = /^[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]{1,4})?$/

function applyFilterToQueryBuilder(
    qb: SelectQueryBuilder<RecordSchema>,
    filter: Filter,
    index: number,
): void {
    const fieldParam = `filter_field_${index}`
    switch (filter.operator) {
        case FilterOperator.EXISTS: {
            qb.andWhere(
                `EXISTS (
                    SELECT 1 FROM cell
                    WHERE cell."recordId" = record.id
                      AND cell."fieldId" = :${fieldParam}
                      AND cell."projectId" = record."projectId"
                      AND cell.value IS NOT NULL
                      AND cell.value != ''
                )`,
                { [fieldParam]: filter.fieldId },
            )
            break
        }
        case FilterOperator.NOT_EXISTS: {
            qb.andWhere(
                `NOT EXISTS (
                    SELECT 1 FROM cell
                    WHERE cell."recordId" = record.id
                      AND cell."fieldId" = :${fieldParam}
                      AND cell."projectId" = record."projectId"
                      AND cell.value IS NOT NULL
                      AND cell.value != ''
                )`,
                { [fieldParam]: filter.fieldId },
            )
            break
        }
        case FilterOperator.EQ: {
            const valParam = `filter_val_${index}`
            qb.andWhere(
                `COALESCE((SELECT cell.value FROM cell WHERE cell."recordId" = record.id AND cell."fieldId" = :${fieldParam} AND cell."projectId" = record."projectId" LIMIT 1), '') = :${valParam}`,
                {
                    [fieldParam]: filter.fieldId,
                    [valParam]: filter.value,
                },
            )
            break
        }
        case FilterOperator.NEQ: {
            const valParam = `filter_val_${index}`
            qb.andWhere(
                `COALESCE((SELECT cell.value FROM cell WHERE cell."recordId" = record.id AND cell."fieldId" = :${fieldParam} AND cell."projectId" = record."projectId" LIMIT 1), '') != :${valParam}`,
                {
                    [fieldParam]: filter.fieldId,
                    [valParam]: filter.value,
                },
            )
            break
        }
        case FilterOperator.CO: {
            const patternParam = `filter_pattern_${index}`
            const escaped = filter.value.replace(/([%_\\])/g, '\\$1')
            qb.andWhere(
                `COALESCE((SELECT cell.value FROM cell WHERE cell."recordId" = record.id AND cell."fieldId" = :${fieldParam} AND cell."projectId" = record."projectId" LIMIT 1), '') ILIKE :${patternParam}`,
                {
                    [fieldParam]: filter.fieldId,
                    [patternParam]: `%${escaped}%`,
                },
            )
            break
        }
        case FilterOperator.GT:
        case FilterOperator.GTE:
        case FilterOperator.LT:
        case FilterOperator.LTE: {
            const trimmedFilter = filter.value.trim()
            if (!STRICT_NUMERIC_FILTER_REGEX.test(trimmedFilter)) {
                qb.andWhere('1 = 0')
                break
            }
            const sqlOp = filter.operator === FilterOperator.GT
                ? '>'
                : filter.operator === FilterOperator.GTE
                    ? '>='
                    : filter.operator === FilterOperator.LT
                        ? '<'
                        : '<='
            const numParam = `filter_num_${index}`
            // PostgreSQL / PGlite compatibility: Use ::numeric with a bounded regex guard
            // to support arbitrary-precision numbers and prevent 22003 overflow errors on extreme values.
            qb.andWhere(
                `EXISTS (
                    SELECT 1 FROM cell
                    WHERE cell."recordId" = record.id
                      AND cell."fieldId" = :${fieldParam}
                      AND cell."projectId" = record."projectId"
                      AND (
                          CASE
                              WHEN cell.value IS NOT NULL
                               AND LENGTH(TRIM(cell.value)) <= 500
                               AND TRIM(cell.value) ~ '^[-+]?([0-9]+(\\.[0-9]+)?|\\.[0-9]+)([eE][-+]?[0-9]{1,4})?$'
                              THEN (TRIM(cell.value))::numeric
                              ELSE NULL
                          END
                      ) ${sqlOp} :${numParam}::numeric
                )`,
                {
                    [fieldParam]: filter.fieldId,
                    [numParam]: trimmedFilter,
                },
            )
            break
        }
    }
}



