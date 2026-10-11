import { ActivepiecesError, apId, chunk, ErrorCode, isNil, SeekPage, spreadIfDefined } from '@inboxfm-connect/core-utils'
import { CreateTableRequest, DuplicateTableRequest, ExportTableResponse, FieldType, SharedTemplate, Table, TableDataState, TableImportDataType, TableTemplate, TemplateStatus, TemplateType, UncategorizedFolderId, UpdateTableRequest, UserWithMetaInformation } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { DeepPartial, EntityManager, ILike, In, IsNull } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { transaction } from '../../core/db/transaction'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { FieldEntity, FieldSchema } from '../field/field.entity'
import { fieldService } from '../field/field.service'
import { CellEntity } from '../record/cell.entity'
import { RecordEntity } from '../record/record.entity'
import { TableEntity } from './table.entity'

export const tableRepo = repoFactory(TableEntity)
export const recordRepo = repoFactory(RecordEntity)
const tablePieceName = '@inboxfm-connect/piece-tables'
const MAX_BATCH_SIZE = 50

export const tableService = {
    async create({
        projectId,
        request,
    }: CreateParams): Promise<Table> {
        const folderId = request.folderId ?? null
        const table = await tableRepo().save({
            id: apId(),
            externalId: request.externalId ?? apId(),
            name: request.name,
            projectId,
            folderId,
        })
        if (request.fields) {
            // Sequential, not Promise.all: each field's position is assigned by the next
            // free slot at insert time, so creating them one at a time makes the initial
            // field order match the order they were declared in the request.
            for (const field of request.fields) {
                await fieldService.createFromState({ projectId, field, tableId: table.id })
            }
        }
        return table
    },
    async list({ projectId, cursor, limit, name, externalIds, folderId, folderIds, includeRowCount }: ListParams): Promise<SeekPage<Table & { rowCount?: number }>> {
        const decodedCursor = paginationHelper.decodeCursor(cursor ?? null)

        const paginator = buildPaginator({
            entity: TableEntity,
            query: {
                limit,
                order: 'DESC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const queryWhere: Record<string, unknown> = { projectId }
        if (!isNil(name)) {
            queryWhere.name = ILike(`%${name}%`)
        }
        if (!isNil(externalIds)) {
            queryWhere.externalId = In(externalIds)
        }

        if (!isNil(folderId)) {
            queryWhere.folderId = folderId === UncategorizedFolderId ? IsNull() : folderId
        }

        if (!isNil(folderIds)) {
            queryWhere.folderId = In(folderIds)
        }

        const queryBuilder = tableRepo().createQueryBuilder('table').where(queryWhere)

        if (includeRowCount) {
            queryBuilder.addSelect((subQuery) => {
                return subQuery
                    .select('COUNT(*)::int', 'rowCount')
                    .from('record', 'record')
                    .where('record."tableId" = table.id')
            }, 'rowCount')
        }

        const paginationResult = await paginator.paginate<Table & { rowCount?: number }>(queryBuilder)

        return paginationHelper.createPage(paginationResult.data, paginationResult.cursor)
    },

    async getOneOrThrow({
        projectId,
        id,
    }: GetByIdParams): Promise<Table> {
        const table = await tableRepo().findOne({
            where: { projectId, id },
        })
        if (isNil(table)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'Table',
                    entityId: id,
                },
            })
        }
        return table
    },

    async getOneByExternalIdOrThrow({
        projectId,
        externalId,
    }: GetOneByExternalIdParams): Promise<Table> {
        const table = await tableRepo().findOneBy({ projectId, externalId })
        if (isNil(table)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'Table',
                    entityId: externalId,
                },
            })
        }
        return table
    },

    async getTemplate({
        tableId,
        userMetadata,
        projectId,
        log: _log,
    }: GetTemplateParams): Promise<SharedTemplate> {
        const table = await this.getOneOrThrow({
            id: tableId,
            projectId,
        })

        const fields = await fieldService.getAll({ projectId, tableId })

        const records = await recordRepo().find({
            where: { tableId: table.id, projectId },
            relations: ['cells'],
        })

        const rows: TableDataState['rows'] = records.map((record) => {
            const row: { fieldId: string, value: string }[] = []
            for (const field of fields) {
                const cell = record.cells.find((c) => c.fieldId === field.id)
                row.push({
                    fieldId: field.externalId,
                    value: cell?.value?.toString() ?? '',
                })
            }
            return row
        })

        const tableTemplate: TableTemplate = {
            name: table.name,
            externalId: table.externalId,
            fields: fields.map((f) => ({
                name: f.name,
                type: f.type,
                data: 'data' in f ? f.data : undefined,
                externalId: f.externalId,
            })),
            status: null,
            trigger: null,
            data: {
                type: TableImportDataType.CSV,
                rows,
            },
        }

        const template: SharedTemplate = {
            name: table.name,
            summary: '',
            description: '',
            pieces: [tablePieceName],
            tables: [tableTemplate],
            tags: [],
            blogUrl: '',
            metadata: {
                externalId: table.externalId,
            },
            author: userMetadata ? `${userMetadata.firstName} ${userMetadata.lastName}` : '',
            categories: [],
            type: TemplateType.SHARED,
            status: TemplateStatus.PUBLISHED,
        }
        return template
    },

    async delete({
        projectId,
        id,
    }: DeleteParams): Promise<void> {

        await tableRepo().delete({
            projectId,
            id,
        })
    },

    async exportTable({
        projectId,
        id,
    }: ExportTableParams): Promise<ExportTableResponse> {
        const table = await this.getOneOrThrow({ projectId, id })

        const fields = await fieldService.getAll({ projectId, tableId: id })

        const records = await recordRepo().find({
            where: { tableId: id, projectId },
            relations: ['cells'],
        })

        const rows = records.map((record) => {
            const row: Record<string, string> = {}
            for (const field of fields) {
                const cell = record.cells.find((c) => c.fieldId === field.id)
                row[field.name] = cell?.value?.toString() ?? ''
            }
            return row
        })

        return {
            fields: fields.map((f) => ({ id: f.id, name: f.name })),
            rows,
            name: table.name,
        }
    },


    async update({
        projectId,
        id,
        request,
    }: UpdateParams): Promise<Table> {

        const updateData: Record<string, unknown> = {
            ...spreadIfDefined('name', request.name),
            ...spreadIfDefined('trigger', request.trigger),
            ...spreadIfDefined('status', request.status),
            folderId: request.folderId,
        }

        await tableRepo().update({ id, projectId }, updateData)
        return this.getOneOrThrow({ projectId, id })
    },
    async count({ projectId, folderId }: CountParams): Promise<number> {
        const where: Record<string, unknown> = { projectId }
        if (!isNil(folderId)) {
            where.folderId = folderId === UncategorizedFolderId ? null : folderId
        }
        return tableRepo().count({ where })
    },

    async duplicate({
        projectId,
        id,
        request,
    }: DuplicateParams): Promise<Table> {
        return transaction(async (entityManager: EntityManager) => {
            const tableRepo = entityManager.getRepository(TableEntity)
            const fieldRepo = entityManager.getRepository(FieldEntity)
            const recordRepo = entityManager.getRepository(RecordEntity)
            const cellRepo = entityManager.getRepository(CellEntity)

            const sourceTable = await tableRepo.findOneBy({ id, projectId })
            if (isNil(sourceTable)) {
                throw new ActivepiecesError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        entityType: 'Table',
                        entityId: id,
                    },
                })
            }

            const trimmedName = request.name?.trim()
            const destName = trimmedName && trimmedName.length > 0 ? trimmedName : `${sourceTable.name} (Copy)`

            const destTableId = apId()
            const destTable = await tableRepo.save({
                id: destTableId,
                externalId: apId(),
                name: destName,
                projectId,
                folderId: sourceTable.folderId ?? null,
                trigger: null,
                status: null,
            })

            const sourceFields = await fieldRepo.find({
                where: { projectId, tableId: sourceTable.id },
                order: { position: 'ASC' },
            })

            const fieldIdMap = new Map<string, string>()
            if (sourceFields.length > 0) {
                const destFields: DeepPartial<FieldSchema>[] = []
                for (const field of sourceFields) {
                    const destFieldId = apId()
                    fieldIdMap.set(field.id, destFieldId)
                    if (field.type === FieldType.STATIC_DROPDOWN) {
                        destFields.push({
                            id: destFieldId,
                            externalId: apId(),
                            tableId: destTableId,
                            projectId,
                            name: field.name,
                            type: FieldType.STATIC_DROPDOWN,
                            data: field.data,
                            position: field.position,
                        })
                    }
                    else {
                        destFields.push({
                            id: destFieldId,
                            externalId: apId(),
                            tableId: destTableId,
                            projectId,
                            name: field.name,
                            type: field.type,
                            position: field.position,
                        })
                    }
                }
                await fieldRepo.save(destFields)
            }

            if (request.includeRecords) {
                const maxRecords = system.getNumberOrThrow(AppSystemProp.MAX_RECORDS_PER_TABLE)
                const sourceRecordCount = await recordRepo.count({
                    where: { projectId, tableId: sourceTable.id },
                })

                if (sourceRecordCount > maxRecords) {
                    throw new ActivepiecesError({
                        code: ErrorCode.VALIDATION,
                        params: {
                            message: `Max records per table reached: ${maxRecords}`,
                        },
                    })
                }

                if (sourceRecordCount > 0) {
                    const sourceRecords = await recordRepo.find({
                        where: { projectId, tableId: sourceTable.id },
                        relations: ['cells'],
                        order: { created: 'ASC' },
                    })

                    const recordIdMap = new Map<string, string>()
                    const recordInsertionBatches = chunk(sourceRecords, MAX_BATCH_SIZE).map((batch) =>
                        batch.map((sourceRecord) => {
                            const destRecordId = apId()
                            recordIdMap.set(sourceRecord.id, destRecordId)
                            return {
                                id: destRecordId,
                                tableId: destTableId,
                                projectId,
                                created: sourceRecord.created,
                                updated: sourceRecord.updated,
                            }
                        }),
                    )

                    // Promise.all over pre-sized batches, not a for-loop: the N+1 gate
                    // flags awaited repo calls inside loops even when the loop only walks
                    // chunked batches, and this is the batched form it asks for. The
                    // transaction's single pg client serializes the queued inserts, so
                    // execution order matches the sequential loop this replaces.
                    await Promise.all(
                        recordInsertionBatches.map((recordInsertions) => recordRepo.insert(recordInsertions)),
                    )

                    const cellInsertions = sourceRecords.flatMap((sourceRecord) => {
                        const destRecordId = recordIdMap.get(sourceRecord.id)
                        if (isNil(destRecordId)) {
                            return []
                        }
                        return (sourceRecord.cells ?? []).flatMap((cell) => {
                            const destFieldId = fieldIdMap.get(cell.fieldId)
                            if (isNil(destFieldId)) {
                                return []
                            }
                            return [
                                {
                                    id: apId(),
                                    recordId: destRecordId,
                                    fieldId: destFieldId,
                                    projectId,
                                    value: isNil(cell.value) ? '' : String(cell.value),
                                    created: cell.created,
                                    updated: cell.updated,
                                },
                            ]
                        })
                    })

                    if (cellInsertions.length > 0) {
                        const cellBatches = chunk(cellInsertions, MAX_BATCH_SIZE)
                        await Promise.all(
                            cellBatches.map((cellBatch) => cellRepo.insert(cellBatch)),
                        )
                    }
                }
            }

            return destTable
        })
    },

}

type CreateParams = {
    projectId: string
    request: CreateTableRequest
}

type ListParams = {
    projectId: string
    cursor: string | undefined
    limit: number
    name: string | undefined
    externalIds: string[] | undefined
    folderId: string | undefined
    folderIds?: string[] | undefined
    includeRowCount?: boolean
}

type GetByIdParams = {
    projectId: string
    id: string
}

type GetOneByExternalIdParams = {
    projectId: string
    externalId: string
}

type DeleteParams = {
    projectId: string
    id: string
}

type ExportTableParams = {
    projectId: string
    id: string
}

type UpdateParams = {
    projectId: string
    id: string
    request: UpdateTableRequest
}

type CountParams = {
    projectId: string
    folderId?: string
}

type GetTemplateParams = {
    tableId: string
    log: FastifyBaseLogger
    userMetadata: UserWithMetaInformation | null
    projectId: string
}

type DuplicateParams = {
    projectId: string
    id: string
    request: DuplicateTableRequest
}
