import { describe, it, expect } from 'vitest'
import { CountFlowsRequest } from '../../src/lib/flows/dto/count-flows-request'
import { CreateFlowRequest } from '../../src/lib/flows/dto/create-flow-request'
import { CreateMCPServerFromStepParams } from '../../src/lib/flows/dto/flow-mcp.requests'
import {
    ListFlowsRequest,
    GetFlowQueryParamsRequest,
    ListFlowVersionRequest,
} from '../../src/lib/flows/dto/list-flows-request'
import { FlowStatus } from '../../src/lib/flows/flow'
import { FlowVersionState } from '../../src/lib/flows/flow-version'

describe('Flow DTOs and MCP Request Schemas', () => {
    describe('CountFlowsRequest', () => {
        it('should accept valid requests with projectId and optional folderId', () => {
            const parsedWithoutFolder = CountFlowsRequest.safeParse({ projectId: 'proj_123' })
            expect(parsedWithoutFolder.success).toBe(true)
            if (parsedWithoutFolder.success) {
                expect(parsedWithoutFolder.data.projectId).toBe('proj_123')
                expect(parsedWithoutFolder.data.folderId).toBeUndefined()
            }

            const parsedWithFolder = CountFlowsRequest.safeParse({
                projectId: 'proj_123',
                folderId: 'folder_456',
            })
            expect(parsedWithFolder.success).toBe(true)
            if (parsedWithFolder.success) {
                expect(parsedWithFolder.data.folderId).toBe('folder_456')
            }
        })

        it('should reject requests missing projectId', () => {
            const parsed = CountFlowsRequest.safeParse({})
            expect(parsed.success).toBe(false)
        })
    })

    describe('CreateFlowRequest', () => {
        it('should validate minimal create flow request', () => {
            const valid = {
                displayName: 'My Integration Flow',
                projectId: 'proj_abc',
            }
            const parsed = CreateFlowRequest.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.displayName).toBe('My Integration Flow')
                expect(parsed.data.projectId).toBe('proj_abc')
            }
        })

        it('should validate request with folders, template, and metadata', () => {
            const fullRequest = {
                displayName: 'Template Flow',
                projectId: 'proj_abc',
                folderId: 'fld_1',
                folderName: 'Marketing',
                templateId: 'tmpl_99',
                metadata: { category: 'crm', environment: 'production' },
            }
            const parsed = CreateFlowRequest.safeParse(fullRequest)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.folderId).toBe('fld_1')
                expect(parsed.data.templateId).toBe('tmpl_99')
                expect(parsed.data.metadata).toEqual({ category: 'crm', environment: 'production' })
            }
        })

        it('should fail when required displayName or projectId are absent', () => {
            expect(CreateFlowRequest.safeParse({ projectId: 'p1' }).success).toBe(false)
            expect(CreateFlowRequest.safeParse({ displayName: 'Flow 1' }).success).toBe(false)
        })
    })

    describe('CreateMCPServerFromStepParams', () => {
        it('should validate complete MCP server from step parameters', () => {
            const valid = {
                flowId: 'flow_123',
                flowVersionId: 'fver_456',
                stepName: 'step_fetch_records',
            }
            const parsed = CreateMCPServerFromStepParams.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.stepName).toBe('step_fetch_records')
            }
        })

        it('should reject when any of flowId, flowVersionId, or stepName is missing', () => {
            expect(CreateMCPServerFromStepParams.safeParse({ flowId: 'f1', flowVersionId: 'v1' }).success).toBe(false)
            expect(CreateMCPServerFromStepParams.safeParse({ flowId: 'f1', stepName: 's1' }).success).toBe(false)
            expect(CreateMCPServerFromStepParams.safeParse({ flowVersionId: 'v1', stepName: 's1' }).success).toBe(false)
        })
    })

    describe('ListFlowsRequest', () => {
        it('should parse minimal list request with projectId', () => {
            const parsed = ListFlowsRequest.safeParse({ projectId: 'proj_abc' })
            expect(parsed.success).toBe(true)
        })

        it('should coerce limit and handle array/scalar query formats', () => {
            const rawQuery = {
                projectId: 'proj_abc',
                limit: '30',
                cursor: 'cursor_token_123',
                status: FlowStatus.ENABLED,
                folderIds: ['folder_1', 'folder_2'],
                versionState: FlowVersionState.LOCKED,
            }
            const parsed = ListFlowsRequest.safeParse(rawQuery)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.limit).toBe(30)
                expect(parsed.data.status).toEqual([FlowStatus.ENABLED])
                expect(parsed.data.folderIds).toEqual(['folder_1', 'folder_2'])
                expect(parsed.data.versionState).toBe(FlowVersionState.LOCKED)
            }
        })

        it('should parse status when given as an array of valid statuses', () => {
            const rawQuery = {
                projectId: 'proj_abc',
                status: [FlowStatus.ENABLED, FlowStatus.DISABLED],
            }
            const parsed = ListFlowsRequest.safeParse(rawQuery)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.status).toEqual([FlowStatus.ENABLED, FlowStatus.DISABLED])
            }
        })
    })

    describe('GetFlowQueryParamsRequest and ListFlowVersionRequest', () => {
        it('should validate GetFlowQueryParamsRequest with optional versionId', () => {
            expect(GetFlowQueryParamsRequest.safeParse({}).success).toBe(true)
            const withVersion = GetFlowQueryParamsRequest.safeParse({ versionId: 'ver_1' })
            expect(withVersion.success).toBe(true)
            if (withVersion.success) {
                expect(withVersion.data.versionId).toBe('ver_1')
            }
        })

        it('should validate and coerce ListFlowVersionRequest', () => {
            const parsed = ListFlowVersionRequest.safeParse({ limit: '15', cursor: 'next_page' })
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.limit).toBe(15)
                expect(parsed.data.cursor).toBe('next_page')
            }
        })
    })
})
