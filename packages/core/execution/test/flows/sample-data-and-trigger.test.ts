import { describe, it, expect } from 'vitest'
import { apId } from '@inboxfm-connect/core-utils'
import {
    SampleDataFileType,
    SampleDataDataType,
    DATA_TYPE_KEY_IN_FILE_METADATA,
    SaveSampleDataRequest,
    GetSampleDataRequest,
    CreateStepRunRequestBody,
    StepExecutionPath,
    SampleDataSetting,
    DEFAULT_SAMPLE_DATA_SETTINGS,
} from '../../src/lib/flows/sample-data'
import {
    TriggerRunStatus,
    TriggerStatusReport,
} from '../../src/lib/flows/triggers/trigger-run'
import {
    ListTriggerEventsRequest,
    SaveTriggerEventRequest,
} from '../../src/lib/flows/triggers/trigger-events/trigger-events-dto'

describe('Sample Data and Trigger Run Contracts', () => {
    const validProjectId = apId()

    describe('Sample Data contracts', () => {
        it('should define sample data file and data type constants', () => {
            expect(SampleDataFileType.INPUT).toBe('INPUT')
            expect(SampleDataFileType.OUTPUT).toBe('OUTPUT')
            expect(SampleDataDataType.JSON).toBe('JSON')
            expect(SampleDataDataType.STRING).toBe('STRING')
            expect(DATA_TYPE_KEY_IN_FILE_METADATA).toBe('dataType')
        })

        it('should validate SaveSampleDataRequest schema', () => {
            const valid = {
                stepName: 'step_parse_csv',
                payload: { rows: [1, 2, 3] },
                type: SampleDataFileType.OUTPUT,
            }
            expect(SaveSampleDataRequest.safeParse(valid).success).toBe(true)

            const invalidType = {
                ...valid,
                type: 'UNSUPPORTED',
            }
            expect(SaveSampleDataRequest.safeParse(invalidType).success).toBe(false)
        })

        it('should validate GetSampleDataRequest schema', () => {
            const valid = {
                flowId: 'flow_1',
                flowVersionId: 'ver_1',
                stepName: 'step_1',
                projectId: validProjectId,
                type: SampleDataFileType.INPUT,
            }
            expect(GetSampleDataRequest.safeParse(valid).success).toBe(true)

            const missingField = {
                flowId: 'flow_1',
                stepName: 'step_1',
            }
            expect(GetSampleDataRequest.safeParse(missingField).success).toBe(false)
        })

        it('should validate CreateStepRunRequestBody', () => {
            const valid = {
                projectId: validProjectId,
                flowVersionId: 'ver_abc',
                stepName: 'step_ai_generate',
            }
            expect(CreateStepRunRequestBody.safeParse(valid).success).toBe(true)
        })

        it('should validate StepExecutionPath tuple format', () => {
            const validPath = [
                ['loop_step', 0],
                ['loop_step', 1],
                ['branch_step', 2],
            ]
            expect(StepExecutionPath.safeParse(validPath).success).toBe(true)

            const invalidPath = [['invalid_without_index']]
            expect(StepExecutionPath.safeParse(invalidPath).success).toBe(false)
        })

        it('should validate SampleDataSetting and default values', () => {
            expect(DEFAULT_SAMPLE_DATA_SETTINGS.sampleDataFileId).toBeUndefined()
            expect(DEFAULT_SAMPLE_DATA_SETTINGS.sampleDataInputFileId).toBeUndefined()

            const custom = {
                sampleDataFileId: 'file_out_1',
                sampleDataInputFileId: 'file_in_1',
                lastTestDate: '2026-10-01T00:00:00.000Z',
            }
            expect(SampleDataSetting.safeParse(custom).success).toBe(true)
        })
    })

    describe('Trigger Run and Event DTOs', () => {
        it('should define TriggerRunStatus enum values', () => {
            expect(TriggerRunStatus.COMPLETED).toBe('COMPLETED')
            expect(TriggerRunStatus.FAILED).toBe('FAILED')
            expect(TriggerRunStatus.INTERNAL_ERROR).toBe('INTERNAL_ERROR')
            expect(TriggerRunStatus.TIMED_OUT).toBe('TIMED_OUT')
        })

        it('should validate TriggerStatusReport structure', () => {
            const validReport = {
                pieces: {
                    '@inboxfm-connect/piece-gmail': {
                        dailyStats: {
                            '2026-10-01': { success: 100, failure: 2 },
                            '2026-10-02': { success: 150, failure: 0 },
                        },
                        totalRuns: 252,
                    },
                },
            }
            expect(TriggerStatusReport.safeParse(validReport).success).toBe(true)
        })

        it('should validate ListTriggerEventsRequest with coercion and ApId format', () => {
            const valid = {
                projectId: validProjectId,
                flowId: 'flow_xyz',
                limit: '25',
                cursor: 'cursor_token',
            }
            const parsed = ListTriggerEventsRequest.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.limit).toBe(25)
                expect(parsed.data.flowId).toBe('flow_xyz')
            }

            const invalidId = {
                ...valid,
                projectId: 'short_id',
            }
            expect(ListTriggerEventsRequest.safeParse(invalidId).success).toBe(false)
        })

        it('should validate SaveTriggerEventRequest schema', () => {
            const valid = {
                projectId: validProjectId,
                flowId: 'flow_xyz',
                mockData: { email: 'user@example.com', body: 'Sample message' },
            }
            expect(SaveTriggerEventRequest.safeParse(valid).success).toBe(true)
        })
    })
})
