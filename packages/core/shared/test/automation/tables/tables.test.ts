import { describe, expect, it } from 'vitest'
import {
    PopulatedTable,
    Table,
    TableAutomationStatus,
    TableAutomationTrigger,
} from '../../../src/lib/automation/tables/table'
import {
    Field,
    FieldType,
    StaticDropdownEmptyOption,
} from '../../../src/lib/automation/tables/field'
import {
    PopulatedRecord,
    Record as TableRecord,
} from '../../../src/lib/automation/tables/record'
import {
    TableWebhook,
    TableWebhookEventType,
} from '../../../src/lib/automation/tables/table-webhook'
import {
    CreateFieldRequest,
    ListFieldsRequestQuery,
    UpdateFieldRequest,
} from '../../../src/lib/automation/tables/dto/fields.dto'
import {
    CreateRecordsRequest,
    DeleteRecordsRequest,
    Filter,
    FilterOperator,
    ListRecordsRequest,
    UpdateRecordRequest,
} from '../../../src/lib/automation/tables/dto/records.dto'
import {
    CountTablesRequest,
    CreateTableRequest,
    CreateTableWebhookRequest,
    ExportTableResponse,
    FieldState,
    ListTablesRequest,
    UpdateTableRequest,
} from '../../../src/lib/automation/tables/dto/tables.dto'

describe('Table and PopulatedTable schemas', () => {
    const validTable = {
        id: '123456789012345678901',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        name: 'Customers',
        folderId: null,
        projectId: 'proj-123',
        externalId: 'ext-customers',
        status: TableAutomationStatus.ENABLED,
        trigger: TableAutomationTrigger.ON_NEW_RECORD,
    }

    it('parses valid table with automation enabled', () => {
        const parsed = Table.parse(validTable)
        expect(parsed.name).toBe('Customers')
        expect(parsed.status).toBe(TableAutomationStatus.ENABLED)
        expect(parsed.trigger).toBe(TableAutomationTrigger.ON_NEW_RECORD)
    })

    it('parses table with null status, trigger, and folderId', () => {
        const parsed = Table.parse({
            ...validTable,
            status: null,
            trigger: null,
            folderId: null,
        })
        expect(parsed.status).toBeNull()
        expect(parsed.trigger).toBeNull()
    })

    it('parses PopulatedTable including fields array', () => {
        const populated = {
            ...validTable,
            fields: [
                {
                    id: '123456789012345678902',
                    created: '2026-01-01T00:00:00.000Z',
                    updated: '2026-01-01T00:00:00.000Z',
                    name: 'Email',
                    externalId: 'f-email',
                    type: FieldType.TEXT,
                    tableId: validTable.id,
                    projectId: validTable.projectId,
                    position: 0,
                },
            ],
        }
        const parsed = PopulatedTable.parse(populated)
        expect(parsed.fields).toHaveLength(1)
        expect(parsed.fields[0].type).toBe(FieldType.TEXT)
    })
})

describe('Field and FieldType schemas', () => {
    const baseField = {
        id: '123456789012345678903',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        name: 'Age',
        externalId: 'f-age',
        tableId: 'tab-1',
        projectId: 'proj-1',
        position: 1,
    }

    it('parses NUMBER, DATE, and TEXT field types without options data', () => {
        const numField = Field.parse({ ...baseField, type: FieldType.NUMBER })
        expect(numField.type).toBe(FieldType.NUMBER)

        const dateField = Field.parse({ ...baseField, name: 'BirthDate', type: FieldType.DATE })
        expect(dateField.type).toBe(FieldType.DATE)

        const textField = Field.parse({ ...baseField, name: 'Notes', type: FieldType.TEXT })
        expect(textField.type).toBe(FieldType.TEXT)
    })

    it('parses STATIC_DROPDOWN field type with required options data', () => {
        const dropdownField = {
            ...baseField,
            name: 'Status',
            type: FieldType.STATIC_DROPDOWN,
            data: {
                options: [{ value: 'Open' }, { value: 'Closed' }],
            },
        }
        const parsed = Field.parse(dropdownField)
        expect(parsed.type).toBe(FieldType.STATIC_DROPDOWN)
        if (parsed.type === FieldType.STATIC_DROPDOWN) {
            expect(parsed.data.options).toHaveLength(2)
        }
    })

    it('rejects STATIC_DROPDOWN missing options array', () => {
        expect(() => Field.parse({
            ...baseField,
            name: 'Status',
            type: FieldType.STATIC_DROPDOWN,
            data: {},
        })).toThrow()
    })

    it('exposes StaticDropdownEmptyOption default', () => {
        expect(StaticDropdownEmptyOption).toEqual({ label: '', value: '' })
    })
})

describe('CreateFieldRequest and UpdateFieldRequest DTOs', () => {
    it('parses CreateFieldRequest for TEXT field with nonnegative position', () => {
        const parsed = CreateFieldRequest.parse({
            name: 'Company',
            type: FieldType.TEXT,
            tableId: 'tab-1',
            position: 2,
        })
        expect(parsed.name).toBe('Company')
        expect(parsed.position).toBe(2)
    })

    it('parses CreateFieldRequest for STATIC_DROPDOWN with options', () => {
        const parsed = CreateFieldRequest.parse({
            name: 'Priority',
            type: FieldType.STATIC_DROPDOWN,
            tableId: 'tab-1',
            data: {
                options: [{ value: 'High' }, { value: 'Low' }],
            },
        })
        expect(parsed.type).toBe(FieldType.STATIC_DROPDOWN)
    })

    it('rejects negative position in CreateFieldRequest', () => {
        expect(() => CreateFieldRequest.parse({
            name: 'BadPos',
            type: FieldType.TEXT,
            tableId: 'tab-1',
            position: -1,
        })).toThrow()
    })

    it('parses UpdateFieldRequest with optional fields', () => {
        expect(UpdateFieldRequest.parse({ name: 'NewName' }).name).toBe('NewName')
        expect(UpdateFieldRequest.parse({ position: 5 }).position).toBe(5)
        expect(UpdateFieldRequest.parse({})).toBeDefined()
    })

    it('parses ListFieldsRequestQuery', () => {
        expect(ListFieldsRequestQuery.parse({ tableId: 'tab-1' }).tableId).toBe('tab-1')
    })
})

describe('Record and PopulatedRecord models', () => {
    it('parses TableRecord model', () => {
        const parsed = TableRecord.parse({
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            tableId: 'tab-1',
            projectId: 'proj-1',
        })
        expect(parsed.tableId).toBe('tab-1')
    })

    it('parses PopulatedRecord with cells map', () => {
        const record = {
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            tableId: 'tab-1',
            projectId: 'proj-1',
            cells: {
                f1: {
                    fieldName: 'Email',
                    value: 'test@example.com',
                    created: '2026-01-01T00:00:00.000Z',
                    updated: '2026-01-01T00:00:00.000Z',
                },
            },
        }
        const parsed = PopulatedRecord.parse(record)
        expect(parsed.cells.f1.fieldName).toBe('Email')
        expect(parsed.cells.f1.value).toBe('test@example.com')
    })
})

describe('CreateRecordsRequest and coerceToString preprocessing', () => {
    it('coerces numbers, booleans, and strings in record cells', () => {
        const payload = {
            tableId: 'tab-1',
            records: [
                [
                    { fieldId: 'f1', value: 12345 },
                    { fieldId: 'f2', value: true },
                    { fieldId: 'f3', value: 'hello' },
                    { fieldId: 'f4', value: null },
                ],
            ],
        }
        const parsed = CreateRecordsRequest.parse(payload)
        expect(parsed.records[0][0].value).toBe('12345')
        expect(parsed.records[0][1].value).toBe('true')
        expect(parsed.records[0][2].value).toBe('hello')
        expect(parsed.records[0][3].value).toBeNull()
    })

    it('parses UpdateRecordRequest with agentUpdate flag', () => {
        const req = {
            tableId: 'tab-1',
            cells: [{ fieldId: 'f1', value: 999 }],
            agentUpdate: true,
        }
        const parsed = UpdateRecordRequest.parse(req)
        expect(parsed.cells?.[0].value).toBe('999')
        expect(parsed.agentUpdate).toBe(true)
    })

    it('parses DeleteRecordsRequest', () => {
        const parsed = DeleteRecordsRequest.parse({
            tableId: 'tab-1',
            ids: ['rec-1', 'rec-2'],
        })
        expect(parsed.ids).toEqual(['rec-1', 'rec-2'])
    })
})

describe('Filter and FilterOperator discriminated union', () => {
    it('validates value-based filters (EQ, NEQ, GT, GTE, LT, LTE, CO)', () => {
        const eqFilter = Filter.parse({ fieldId: 'f1', operator: FilterOperator.EQ, value: 'active' })
        expect(eqFilter.operator).toBe('eq')

        const gtFilter = Filter.parse({ fieldId: 'f2', operator: FilterOperator.GT, value: '100' })
        expect(gtFilter.operator).toBe('gt')

        const coFilter = Filter.parse({ fieldId: 'f3', operator: FilterOperator.CO, value: 'pattern' })
        expect(coFilter.operator).toBe('co')
    })

    it('rejects value-based filters when value is missing', () => {
        expect(() => Filter.parse({ fieldId: 'f1', operator: FilterOperator.EQ })).toThrow()
    })

    it('validates existence-based filters (EXISTS, NOT_EXISTS) without requiring value', () => {
        const existsFilter = Filter.parse({ fieldId: 'f1', operator: FilterOperator.EXISTS })
        expect(existsFilter.operator).toBe('exists')

        const notExistsFilter = Filter.parse({ fieldId: 'f2', operator: FilterOperator.NOT_EXISTS })
        expect(notExistsFilter.operator).toBe('not_exists')
    })

    it('parses ListRecordsRequest with filters array and coerces limit', () => {
        const parsed = ListRecordsRequest.parse({
            tableId: 'tab-1',
            limit: '50',
            cursor: 'cur_123',
            filters: [
                { fieldId: 'f1', operator: FilterOperator.EQ, value: 'active' },
                { fieldId: 'f2', operator: FilterOperator.EXISTS },
            ],
        })
        expect(parsed.limit).toBe(50)
        expect(parsed.filters).toHaveLength(2)
    })
})

describe('CreateTableRequest and SAFE_EXTERNAL_ID_PATTERN', () => {
    it('validates clean alphanumeric, underscore, dot, hyphen externalIds', () => {
        const req = {
            projectId: 'proj-1',
            name: 'Users Table',
            externalId: 'users_table-v1.0',
        }
        const parsed = CreateTableRequest.parse(req)
        expect(parsed.externalId).toBe('users_table-v1.0')
    })

    it('rejects unsafe externalIds: "." and ".."', () => {
        expect(() => CreateTableRequest.parse({
            projectId: 'proj-1',
            name: 'Users',
            externalId: '.',
        })).toThrow()

        expect(() => CreateTableRequest.parse({
            projectId: 'proj-1',
            name: 'Users',
            externalId: '..',
        })).toThrow()
    })

    it('rejects externalIds containing spaces or invalid characters', () => {
        expect(() => CreateTableRequest.parse({
            projectId: 'proj-1',
            name: 'Users',
            externalId: 'my table/name',
        })).toThrow()

        expect(() => CreateTableRequest.parse({
            projectId: 'proj-1',
            name: 'Users',
            externalId: 'test$table',
        })).toThrow()
    })

    it('validates FieldState items inside CreateTableRequest', () => {
        const state: FieldState = {
            name: 'Age',
            type: FieldType.NUMBER,
            externalId: 'f-age',
        }
        const parsed = CreateTableRequest.parse({
            projectId: 'proj-1',
            name: 'Metrics',
            fields: [state],
        })
        expect(parsed.fields?.[0].name).toBe('Age')
    })
})

describe('ExportTableResponse and Webhook DTOs', () => {
    it('parses ExportTableResponse', () => {
        const res = {
            fields: [{ id: 'f1', name: 'Col 1' }],
            rows: [{ f1: 'val1' }],
            name: 'Exported Table',
        }
        const parsed = ExportTableResponse.parse(res)
        expect(parsed.rows).toHaveLength(1)
        expect(parsed.name).toBe('Exported Table')
    })

    it('validates TableWebhook model and CreateTableWebhookRequest', () => {
        const webhook = {
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            projectId: 'proj-1',
            tableId: 'tab-1',
            events: [TableWebhookEventType.RECORD_CREATED, TableWebhookEventType.RECORD_DELETED],
            flowId: 'flow-123',
        }
        expect(TableWebhook.parse(webhook).events).toHaveLength(2)

        const createReq = {
            events: [TableWebhookEventType.RECORD_UPDATED],
            webhookUrl: 'https://webhook.site/abc',
            flowId: 'flow-456',
        }
        expect(CreateTableWebhookRequest.parse(createReq).events).toEqual([TableWebhookEventType.RECORD_UPDATED])
    })

    it('parses UpdateTableRequest, ListTablesRequest, and CountTablesRequest', () => {
        const updateReq = {
            name: 'Updated Name',
            trigger: TableAutomationTrigger.ON_UPDATE_RECORD,
            status: TableAutomationStatus.DISABLED,
            folderId: null,
        }
        expect(UpdateTableRequest.parse(updateReq).status).toBe(TableAutomationStatus.DISABLED)

        const listReq = {
            projectId: 'proj-1',
            limit: '15',
            name: 'SearchQuery',
            externalIds: ['ext-1', 'ext-2'],
            folderIds: 'folder-1',
        }
        const parsedList = ListTablesRequest.parse(listReq)
        expect(parsedList.limit).toBe(15)
        expect(parsedList.externalIds).toEqual(['ext-1', 'ext-2'])
        expect(parsedList.folderIds).toEqual(['folder-1'])

        const countReq = { projectId: 'proj-1', folderId: 'folder-1' }
        expect(CountTablesRequest.parse(countReq).folderId).toBe('folder-1')
    })
})
