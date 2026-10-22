import { describe, expect, it } from 'vitest'
import { CountFlowsRequest } from '../../../src/lib/flows/dto/count-flows-request'
import { CreateFlowRequest } from '../../../src/lib/flows/dto/create-flow-request'
import {
    GetFlowQueryParamsRequest,
    ListFlowsRequest,
    ListFlowVersionRequest,
} from '../../../src/lib/flows/dto/list-flows-request'
import { CreateMCPServerFromStepParams } from '../../../src/lib/flows/dto/flow-mcp.requests'
import {
    CreateFolderRequest,
    DeleteFolderRequest,
    ListFolderRequest,
    UpdateFolderRequest,
} from '../../../src/lib/flows/folders/folder-requests'
import { Folder, UncategorizedFolderId } from '../../../src/lib/flows/folders/folder'
import {
    CancelTestTriggerRequestBody,
    TestTriggerRequestBody,
    TriggerTestStrategy,
} from '../../../src/lib/flows/test-trigger'
import {
    ListTriggerEventsRequest,
    SaveTriggerEventRequest,
} from '../../../src/lib/flows/triggers/trigger-events/trigger-events-dto'
import {
    TriggerRunStatus,
    TriggerStatusReport,
} from '../../../src/lib/flows/triggers/trigger-run'
import { StepRunResponse } from '../../../src/lib/engine/step-run-response'
import {
    DEFAULT_MCP_DATA,
    ERROR_MESSAGES_TO_REDACT,
} from '../../../src/lib/engine/engine-constants'
import { FlowStatus } from '../../../src/lib/flows/flow'
import { FlowVersionState } from '../../../src/lib/flows/flow-version'

describe('flows DTOs, folders, triggers, and constants contracts', () => {
    describe('engine constants', () => {
        it('exports default MCP data with locked state', () => {
            expect(DEFAULT_MCP_DATA.flowId).toBe('mcp-flow-id')
            expect(DEFAULT_MCP_DATA.flowVersionState).toBe(FlowVersionState.LOCKED)
            expect(DEFAULT_MCP_DATA.triggerPieceName).toBe('mcp-trigger-piece-name')
        })

        it('exports error messages to redact array', () => {
            expect(ERROR_MESSAGES_TO_REDACT).toContain('HttpClient#sendRequest')
        })
    })

    describe('flow requests DTOs', () => {
        it('validates CountFlowsRequest with and without folderId', () => {
            const withFolder = CountFlowsRequest.parse({
                projectId: 'proj_123',
                folderId: 'folder_456',
            })
            expect(withFolder.projectId).toBe('proj_123')
            expect(withFolder.folderId).toBe('folder_456')

            const withoutFolder = CountFlowsRequest.parse({ projectId: 'proj_123' })
            expect(withoutFolder.folderId).toBeUndefined()
        })

        it('validates CreateFlowRequest with optional metadata and templates', () => {
            const req = CreateFlowRequest.parse({
                displayName: 'My New Flow',
                projectId: 'proj_123',
                folderName: 'Marketing',
                templateId: 'tmpl_789',
                metadata: { category: 'sales' },
            })
            expect(req.displayName).toBe('My New Flow')
            expect(req.folderName).toBe('Marketing')
            expect(req.templateId).toBe('tmpl_789')
        })

        it('validates CreateMCPServerFromStepParams', () => {
            const params = CreateMCPServerFromStepParams.parse({
                flowId: 'flow_1',
                flowVersionId: 'ver_1',
                stepName: 'step_1',
            })
            expect(params.stepName).toBe('step_1')
        })

        it('validates ListFlowsRequest query coercion and filters', () => {
            const parsed = ListFlowsRequest.parse({
                projectId: 'proj_123',
                limit: '25',
                status: FlowStatus.ENABLED,
                versionState: FlowVersionState.LOCKED,
                name: 'Sync Orders',
            })
            expect(parsed.limit).toBe(25)
            expect(parsed.status).toEqual([FlowStatus.ENABLED])
            expect(parsed.versionState).toBe(FlowVersionState.LOCKED)
        })

        it('validates GetFlowQueryParamsRequest and ListFlowVersionRequest', () => {
            const queryParams = GetFlowQueryParamsRequest.parse({ versionId: 'ver_99' })
            expect(queryParams.versionId).toBe('ver_99')

            const listVer = ListFlowVersionRequest.parse({ limit: '10', cursor: 'c_123' })
            expect(listVer.limit).toBe(10)
            expect(listVer.cursor).toBe('c_123')
        })
    })

    describe('folder schemas and requests', () => {
        it('validates Folder model schema with nullable externalId', () => {
            const folder = Folder.parse({
                id: 'folder_123',
                created: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                projectId: 'proj_123',
                displayName: 'Finance Automations',
                displayOrder: 1,
                externalId: null,
            })
            expect(folder.id).toBe('folder_123')
            expect(folder.externalId).toBeNull()
            expect(UncategorizedFolderId).toBe('NULL')
        })

        it('validates CreateFolderRequest and UpdateFolderRequest', () => {
            const createReq = CreateFolderRequest.parse({
                displayName: 'Support Ops',
                projectId: 'proj_123',
            })
            expect(createReq.displayName).toBe('Support Ops')

            const updateReq = UpdateFolderRequest.parse({ displayName: 'Support Ops v2' })
            expect(updateReq.displayName).toBe('Support Ops v2')
        })

        it('validates DeleteFolderRequest and ListFolderRequest', () => {
            const deleteReq = DeleteFolderRequest.parse({ id: 'folder_del_1' })
            expect(deleteReq.id).toBe('folder_del_1')

            const listReq = ListFolderRequest.parse({
                projectId: 'proj_123',
                limit: '50',
            })
            expect(listReq.limit).toBe(50)
            expect(listReq.projectId).toBe('proj_123')
        })
    })

    describe('test trigger and trigger events', () => {
        it('validates TestTriggerRequestBody with SIMULATION and TEST_FUNCTION', () => {
            const simulationReq = TestTriggerRequestBody.parse({
                projectId: 'mEYVQL4gGPlHsTamd2xtW',
                flowId: 'mEYVQL4gGPlHsTamd2xtX',
                flowVersionId: 'mEYVQL4gGPlHsTamd2xtY',
                testStrategy: TriggerTestStrategy.SIMULATION,
            })
            expect(simulationReq.testStrategy).toBe(TriggerTestStrategy.SIMULATION)

            const testFunctionReq = TestTriggerRequestBody.parse({
                projectId: 'mEYVQL4gGPlHsTamd2xtW',
                flowId: 'mEYVQL4gGPlHsTamd2xtX',
                flowVersionId: 'mEYVQL4gGPlHsTamd2xtY',
                testStrategy: TriggerTestStrategy.TEST_FUNCTION,
            })
            expect(testFunctionReq.testStrategy).toBe(TriggerTestStrategy.TEST_FUNCTION)

            const cancelReq = CancelTestTriggerRequestBody.parse({
                projectId: 'mEYVQL4gGPlHsTamd2xtW',
                flowId: 'mEYVQL4gGPlHsTamd2xtX',
            })
            expect(cancelReq.flowId).toBe('mEYVQL4gGPlHsTamd2xtX')
        })

        it('validates ListTriggerEventsRequest and SaveTriggerEventRequest', () => {
            const listEvents = ListTriggerEventsRequest.parse({
                projectId: 'mEYVQL4gGPlHsTamd2xtW',
                flowId: 'flow_456',
                limit: '20',
            })
            expect(listEvents.limit).toBe(20)

            const saveEvent = SaveTriggerEventRequest.parse({
                projectId: 'mEYVQL4gGPlHsTamd2xtW',
                flowId: 'flow_456',
                mockData: { payload: { orderId: 100 } },
            })
            expect((saveEvent.mockData as any).payload.orderId).toBe(100)
        })

        it('validates TriggerStatusReport schema with piece dailyStats', () => {
            const report = TriggerStatusReport.parse({
                pieces: {
                    '@inboxfm-connect/piece-slack': {
                        dailyStats: {
                            '2026-10-01': { success: 15, failure: 1 },
                        },
                        totalRuns: 16,
                    },
                },
            })
            expect(report.pieces['@inboxfm-connect/piece-slack'].totalRuns).toBe(16)
            expect(TriggerRunStatus.COMPLETED).toBe('COMPLETED')
            expect(TriggerRunStatus.FAILED).toBe('FAILED')
            expect(TriggerRunStatus.INTERNAL_ERROR).toBe('INTERNAL_ERROR')
            expect(TriggerRunStatus.TIMED_OUT).toBe('TIMED_OUT')
        })
    })

    describe('StepRunResponse parsing', () => {
        it('validates successful and failed step run response envelopes', () => {
            const stepRun = StepRunResponse.parse({
                runId: 'run_step_01',
                success: true,
                input: { foo: 'bar' },
                output: { baz: 42 },
                standardError: '',
                standardOutput: 'Processing complete\n',
            })
            expect(stepRun.runId).toBe('run_step_01')
            expect(stepRun.success).toBe(true)
            expect(stepRun.output).toEqual({ baz: 42 })
        })
    })
})
