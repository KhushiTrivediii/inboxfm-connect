import { ActivepiecesError, apId, ErrorCode } from '@inboxfm-connect/core-utils'
import { FieldType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { EntityManager } from 'typeorm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fieldService } from '../../../../src/app/tables/field/field.service'
import { recordService } from '../../../../src/app/tables/record/record.service'
import { tableRepo, tableService } from '../../../../src/app/tables/table/table.service'
import { db } from '../../../helpers/db'
import {
    createMockCell,
    createMockField,
    createMockRecord,
    createMockTable,
} from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Table Duplicate Service', () => {
    it('Test 1 — Schema-only: should duplicate table metadata and all fields with fresh IDs and zero records', async () => {
        const ctx = await createTestContext(app!)
        const folderId = apId()

        const sourceTable = createMockTable({ projectId: ctx.project.id })
        sourceTable.name = 'Source Table'
        sourceTable.folderId = folderId
        await db.save('table', sourceTable)

        const field1 = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 0 })
        field1.name = 'Name'
        field1.type = FieldType.TEXT
        field1.data = null
        const field2 = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 1 })
        field2.name = 'Age'
        field2.type = FieldType.NUMBER
        field2.data = null
        await db.save('field', field1)
        await db.save('field', field2)

        const record = createMockRecord({ tableId: sourceTable.id, projectId: ctx.project.id })
        await db.save('record', record)
        const cell = createMockCell({ recordId: record.id, fieldId: field1.id, projectId: ctx.project.id })
        cell.value = 'Alice'
        await db.save('cell', cell)

        const duplicated = await tableService.duplicate({
            projectId: ctx.project.id,
            id: sourceTable.id,
            request: {},
        })

        expect(duplicated.id).toBeDefined()
        expect(duplicated.id).not.toBe(sourceTable.id)
        expect(duplicated.externalId).toBeDefined()
        expect(duplicated.externalId).not.toBe(sourceTable.externalId)
        expect(duplicated.name).toBe('Source Table (Copy)')
        expect(duplicated.projectId).toBe(ctx.project.id)
        expect(duplicated.folderId).toBe(folderId)
        expect(duplicated.trigger).toBeNull()
        expect(duplicated.status).toBeNull()

        const destFields = await fieldService.getAll({
            tableId: duplicated.id,
            projectId: ctx.project.id,
        })
        expect(destFields.length).toBe(2)
        expect(destFields[0].id).not.toBe(field1.id)
        expect(destFields[0].externalId).not.toBe(field1.externalId)
        expect(destFields[0].name).toBe('Name')
        expect(destFields[0].type).toBe(FieldType.TEXT)
        expect(destFields[0].position).toBe(0)

        expect(destFields[1].id).not.toBe(field2.id)
        expect(destFields[1].externalId).not.toBe(field2.externalId)
        expect(destFields[1].name).toBe('Age')
        expect(destFields[1].type).toBe(FieldType.NUMBER)
        expect(destFields[1].position).toBe(1)

        const destRecords = await db.findManyBy('record', { tableId: duplicated.id, projectId: ctx.project.id })
        expect(destRecords.length).toBe(0)
    })

    it('Test 2 — Full duplication: should copy records and cells with proper ID translation and value preservation', async () => {
        const ctx = await createTestContext(app!)

        const sourceTable = createMockTable({ projectId: ctx.project.id })
        sourceTable.name = 'Products'
        await db.save('table', sourceTable)

        const fieldTitle = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 0 })
        fieldTitle.name = 'Title'
        fieldTitle.type = FieldType.TEXT
        fieldTitle.data = null

        const fieldPrice = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 1 })
        fieldPrice.name = 'Price'
        fieldPrice.type = FieldType.NUMBER
        fieldPrice.data = null

        await db.save('field', fieldTitle)
        await db.save('field', fieldPrice)

        const baseTime = 1700000000000
        const record1 = createMockRecord({ tableId: sourceTable.id, projectId: ctx.project.id })
        record1.created = new Date(baseTime).toISOString()
        const record2 = createMockRecord({ tableId: sourceTable.id, projectId: ctx.project.id })
        record2.created = new Date(baseTime + 1000).toISOString()
        await db.save('record', record1)
        await db.save('record', record2)

        const cell1a = createMockCell({ recordId: record1.id, fieldId: fieldTitle.id, projectId: ctx.project.id })
        cell1a.value = 'Widget A'
        const cell1b = createMockCell({ recordId: record1.id, fieldId: fieldPrice.id, projectId: ctx.project.id })
        cell1b.value = '19.99'
        const cell2a = createMockCell({ recordId: record2.id, fieldId: fieldTitle.id, projectId: ctx.project.id })
        cell2a.value = 'Widget B'
        const cell2b = createMockCell({ recordId: record2.id, fieldId: fieldPrice.id, projectId: ctx.project.id })
        cell2b.value = '49.99'
        await db.save('cell', cell1a)
        await db.save('cell', cell1b)
        await db.save('cell', cell2a)
        await db.save('cell', cell2b)

        const duplicated = await tableService.duplicate({
            projectId: ctx.project.id,
            id: sourceTable.id,
            request: {
                includeRecords: true,
            },
        })

        const destFields = await fieldService.getAll({
            tableId: duplicated.id,
            projectId: ctx.project.id,
        })
        expect(destFields.length).toBe(2)
        const destTitleField = destFields.find((f) => f.name === 'Title')!
        const destPriceField = destFields.find((f) => f.name === 'Price')!

        const destRecords = await db.findManyBy<{ id: string }>('record', { tableId: duplicated.id, projectId: ctx.project.id })
        expect(destRecords.length).toBe(2)
        expect(destRecords.map((r) => r.id)).not.toContain(record1.id)
        expect(destRecords.map((r) => r.id)).not.toContain(record2.id)

        const allProjectCells = await db.findManyBy<{ id: string, recordId: string, fieldId: string, value: string }>('cell', { projectId: ctx.project.id })
        const tableCells = allProjectCells.filter((c) => destRecords.some((r) => r.id === c.recordId))
        expect(tableCells.length).toBe(4)

        const values = tableCells.map((c) => c.value).sort()
        expect(values).toEqual(['19.99', '49.99', 'Widget A', 'Widget B'])

        for (const cell of tableCells) {
            expect([destTitleField.id, destPriceField.id]).toContain(cell.fieldId)
        }

        // Verify deterministic row ordering through recordService.list
        const destRecordsList = await recordService.list({
            tableId: duplicated.id,
            projectId: ctx.project.id,
        })
        expect(destRecordsList.data.length).toBe(2)
        expect(destRecordsList.data[0].cells[destTitleField.id].value).toBe('Widget A')
        expect(destRecordsList.data[0].cells[destPriceField.id].value).toBe('19.99')
        expect(destRecordsList.data[1].cells[destTitleField.id].value).toBe('Widget B')
        expect(destRecordsList.data[1].cells[destPriceField.id].value).toBe('49.99')
    })

    it('Test 3 — Sparse cells: should preserve sparse cell structure without inventing missing cells', async () => {
        const ctx = await createTestContext(app!)

        const sourceTable = createMockTable({ projectId: ctx.project.id })
        sourceTable.name = 'Sparse Table'
        await db.save('table', sourceTable)

        const fieldA = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 0 })
        fieldA.name = 'A'
        fieldA.type = FieldType.TEXT
        fieldA.data = null

        const fieldB = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 1 })
        fieldB.name = 'B'
        fieldB.type = FieldType.TEXT
        fieldB.data = null

        const fieldC = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 2 })
        fieldC.name = 'C'
        fieldC.type = FieldType.TEXT
        fieldC.data = null

        await db.save('field', fieldA)
        await db.save('field', fieldB)
        await db.save('field', fieldC)

        const record = createMockRecord({ tableId: sourceTable.id, projectId: ctx.project.id })
        await db.save('record', record)

        // Only create cell for fieldA; fieldB and fieldC remain sparse/missing
        const cellA = createMockCell({ recordId: record.id, fieldId: fieldA.id, projectId: ctx.project.id })
        cellA.value = 'Only A'
        await db.save('cell', cellA)

        const duplicated = await tableService.duplicate({
            projectId: ctx.project.id,
            id: sourceTable.id,
            request: {
                includeRecords: true,
            },
        })

        const destRecords = await db.findManyBy<{ id: string }>('record', { tableId: duplicated.id, projectId: ctx.project.id })
        expect(destRecords.length).toBe(1)

        const destCells = await db.findManyBy<{ value: string }>('cell', { recordId: destRecords[0].id, projectId: ctx.project.id })
        expect(destCells.length).toBe(1)
        expect(destCells[0].value).toBe('Only A')
    })

    it('Test 4 — Custom name: should use explicitly provided name', async () => {
        const ctx = await createTestContext(app!)

        const sourceTable = createMockTable({ projectId: ctx.project.id })
        sourceTable.name = 'Original Name'
        await db.save('table', sourceTable)

        const duplicated = await tableService.duplicate({
            projectId: ctx.project.id,
            id: sourceTable.id,
            request: {
                name: 'Custom Cloned Name',
            },
        })

        expect(duplicated.name).toBe('Custom Cloned Name')
    })

    it('Test 5 — Field configuration: should preserve TEXT, NUMBER, DATE, and STATIC_DROPDOWN configurations', async () => {
        const ctx = await createTestContext(app!)

        const sourceTable = createMockTable({ projectId: ctx.project.id })
        sourceTable.name = 'Types Table'
        await db.save('table', sourceTable)

        const dropdownData = {
            options: [
                { id: 'opt1', value: 'Option 1', color: '#ff0000' },
                { id: 'opt2', value: 'Option 2', color: '#00ff00' },
            ],
        }

        const textField = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 0 })
        textField.name = 'Text Field'
        textField.type = FieldType.TEXT
        textField.data = null

        const numberField = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 1 })
        numberField.name = 'Number Field'
        numberField.type = FieldType.NUMBER
        numberField.data = null

        const dateField = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 2 })
        dateField.name = 'Date Field'
        dateField.type = FieldType.DATE
        dateField.data = null

        const dropdownField = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 3 })
        dropdownField.name = 'Dropdown Field'
        dropdownField.type = FieldType.STATIC_DROPDOWN
        dropdownField.data = dropdownData

        await db.save('field', textField)
        await db.save('field', numberField)
        await db.save('field', dateField)
        await db.save('field', dropdownField)

        const duplicated = await tableService.duplicate({
            projectId: ctx.project.id,
            id: sourceTable.id,
            request: {},
        })

        const destFields = await fieldService.getAll({
            tableId: duplicated.id,
            projectId: ctx.project.id,
        })

        expect(destFields.length).toBe(4)

        expect(destFields[0].name).toBe('Text Field')
        expect(destFields[0].type).toBe(FieldType.TEXT)

        expect(destFields[1].name).toBe('Number Field')
        expect(destFields[1].type).toBe(FieldType.NUMBER)

        expect(destFields[2].name).toBe('Date Field')
        expect(destFields[2].type).toBe(FieldType.DATE)

        expect(destFields[3].name).toBe('Dropdown Field')
        expect(destFields[3].type).toBe(FieldType.STATIC_DROPDOWN)
        expect(destFields[3].data).toEqual(dropdownData)
    })

    it('Test 6 — Authorization: should reject duplication across different projects', async () => {
        const ctxA = await createTestContext(app!)
        const ctxB = await createTestContext(app!)

        const sourceTable = createMockTable({ projectId: ctxA.project.id })
        sourceTable.name = 'Project A Table'
        await db.save('table', sourceTable)

        await expect(tableService.duplicate({
            projectId: ctxB.project.id,
            id: sourceTable.id,
            request: {},
        })).rejects.toThrow(ActivepiecesError)

        try {
            await tableService.duplicate({
                projectId: ctxB.project.id,
                id: sourceTable.id,
                request: {},
            })
        }
        catch (err) {
            expect((err as ActivepiecesError).error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
        }
    })

    it('Test 7 — Nonexistent source: should return ENTITY_NOT_FOUND error for non-existent table', async () => {
        const ctx = await createTestContext(app!)
        const nonExistentId = apId()

        await expect(tableService.duplicate({
            projectId: ctx.project.id,
            id: nonExistentId,
            request: {},
        })).rejects.toThrow(ActivepiecesError)

        try {
            await tableService.duplicate({
                projectId: ctx.project.id,
                id: nonExistentId,
                request: {},
            })
        }
        catch (err) {
            expect((err as ActivepiecesError).error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
        }
    })

    it('Test 8 — Transaction rollback: should completely roll back all destination records if an error occurs mid-operation', async () => {
        const ctx = await createTestContext(app!)

        const sourceTable = createMockTable({ projectId: ctx.project.id })
        sourceTable.name = 'Rollback Table'
        await db.save('table', sourceTable)

        const field = createMockField({ tableId: sourceTable.id, projectId: ctx.project.id, position: 0 })
        field.name = 'Field 1'
        field.type = FieldType.TEXT
        field.data = null
        await db.save('field', field)

        const record = createMockRecord({ tableId: sourceTable.id, projectId: ctx.project.id })
        await db.save('record', record)

        // Force a transaction failure during record insertion by intercepting EntityManager.insert
        const spy = vi.spyOn(EntityManager.prototype, 'insert').mockImplementation(async function () {
            throw new Error('Simulated failure during table duplication')
        })

        const tablesBefore = await tableRepo().count({ where: { projectId: ctx.project.id } })

        await expect(tableService.duplicate({
            projectId: ctx.project.id,
            id: sourceTable.id,
            request: {
                includeRecords: true,
            },
        })).rejects.toThrow('Simulated failure during table duplication')

        spy.mockRestore()

        const tablesAfter = await tableRepo().count({ where: { projectId: ctx.project.id } })
        expect(tablesAfter).toBe(tablesBefore)

        const destTableCandidate = await tableRepo().findOne({
            where: { projectId: ctx.project.id, name: 'Rollback Table (Copy)' },
        })
        expect(destTableCandidate).toBeNull()
    })
})
