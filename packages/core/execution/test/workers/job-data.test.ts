import { describe, expect, it } from 'vitest'
import {
    EventDestinationJobData,
    ExecuteChatAgentJobData,
    ExecuteExtractPieceMetadataJobData,
    ExecuteFlowJobData,
    ExecutePropertyJobData,
    ExecuteTokenRefreshJobData,
    ExecuteTriggerHookJobData,
    ExecuteValidateAuthJobData,
    getDefaultJobPriority,
    InlineJobPayload,
    JOB_PRIORITY,
    JobData,
    JobPayload,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    NON_SCHEDULED_JOB_TYPES,
    PollingJobData,
    RATE_LIMIT_PRIORITY,
    RefJobPayload,
    RenewWebhookJobData,
    WebhookJobData,
    WorkerJobType,
} from '../../src/lib/workers/job-data'
import { RunEnvironment } from '../../src/lib/flow-run/flow-run'
import { ExecutionType } from '../../src/lib/flow-run/execution/execution-output'
import { FlowTriggerType } from '../../src/lib/flows/triggers/trigger'
import { ResumeReason, StreamStepProgress, TriggerHookType } from '../../src/lib/engine'
import { PackageType, PieceType } from '@inboxfm-connect/core-piece-types'

const mockPiecePackage = {
    packageType: PackageType.REGISTRY,
    pieceType: PieceType.OFFICIAL,
    pieceName: '@inboxfm-connect/piece-slack',
    pieceVersion: '1.2.3',
}

describe('job-data', () => {
    describe('priority constants and calculations', () => {
        it('defines expected JOB_PRIORITY and RATE_LIMIT_PRIORITY ranks', () => {
            expect(JOB_PRIORITY.critical).toBe(1)
            expect(JOB_PRIORITY.high).toBe(2)
            expect(JOB_PRIORITY.medium).toBe(3)
            expect(JOB_PRIORITY.low).toBe(4)
            expect(JOB_PRIORITY.veryLow).toBe(5)
            expect(JOB_PRIORITY.lowest).toBe(6)
            expect(RATE_LIMIT_PRIORITY).toBe('lowest')
        })

        it('assigns veryLow priority to polling and webhook renewal', () => {
            const pollingJob = {
                jobType: WorkerJobType.EXECUTE_POLLING,
            } as JobData
            expect(getDefaultJobPriority(pollingJob)).toBe('veryLow')

            const renewJob = {
                jobType: WorkerJobType.RENEW_WEBHOOK,
            } as JobData
            expect(getDefaultJobPriority(renewJob)).toBe('veryLow')
        })

        it('assigns medium priority to webhooks and event destinations', () => {
            const webhookJob = {
                jobType: WorkerJobType.EXECUTE_WEBHOOK,
            } as JobData
            expect(getDefaultJobPriority(webhookJob)).toBe('medium')

            const eventJob = {
                jobType: WorkerJobType.EVENT_DESTINATION,
            } as JobData
            expect(getDefaultJobPriority(eventJob)).toBe('medium')
        })

        it('assigns critical priority to interactive and sync operations', () => {
            const criticalTypes = [
                WorkerJobType.EXECUTE_PROPERTY,
                WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION,
                WorkerJobType.EXECUTE_VALIDATION,
                WorkerJobType.EXECUTE_TRIGGER_HOOK,
                WorkerJobType.EXECUTE_TOKEN_REFRESH,
            ]
            for (const type of criticalTypes) {
                expect(getDefaultJobPriority({ jobType: type } as JobData)).toBe('critical')
            }
        })

        it('assigns high priority to chat agents', () => {
            const chatJob = {
                jobType: WorkerJobType.EXECUTE_CHAT_AGENT,
            } as JobData
            expect(getDefaultJobPriority(chatJob)).toBe('high')
        })

        it('computes EXECUTE_FLOW priority correctly for testing, sync, and async production', () => {
            // Testing environment -> always high
            const testingJob = {
                jobType: WorkerJobType.EXECUTE_FLOW,
                environment: RunEnvironment.TESTING,
                workerHandlerId: null,
            } as JobData
            expect(getDefaultJobPriority(testingJob)).toBe('high')

            // Production without workerHandlerId -> medium (async)
            const asyncProdJob = {
                jobType: WorkerJobType.EXECUTE_FLOW,
                environment: RunEnvironment.PRODUCTION,
                workerHandlerId: null,
            } as JobData
            expect(getDefaultJobPriority(asyncProdJob)).toBe('medium')

            // Production with workerHandlerId -> high (sync)
            const syncProdJob = {
                jobType: WorkerJobType.EXECUTE_FLOW,
                environment: RunEnvironment.PRODUCTION,
                workerHandlerId: 'worker-handler-123',
            } as JobData
            expect(getDefaultJobPriority(syncProdJob)).toBe('high')
        })
    })

    describe('NON_SCHEDULED_JOB_TYPES', () => {
        it('contains all interactive and real-time execution types', () => {
            expect(NON_SCHEDULED_JOB_TYPES).toContain(WorkerJobType.EXECUTE_WEBHOOK)
            expect(NON_SCHEDULED_JOB_TYPES).toContain(WorkerJobType.EXECUTE_FLOW)
            expect(NON_SCHEDULED_JOB_TYPES).toContain(WorkerJobType.EXECUTE_VALIDATION)
            expect(NON_SCHEDULED_JOB_TYPES).toContain(WorkerJobType.EXECUTE_TRIGGER_HOOK)
            expect(NON_SCHEDULED_JOB_TYPES).toContain(WorkerJobType.EXECUTE_PROPERTY)
            expect(NON_SCHEDULED_JOB_TYPES).toContain(WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION)
            expect(NON_SCHEDULED_JOB_TYPES).toContain(WorkerJobType.EXECUTE_CHAT_AGENT)
            expect(NON_SCHEDULED_JOB_TYPES).toContain(WorkerJobType.EXECUTE_TOKEN_REFRESH)
            expect(NON_SCHEDULED_JOB_TYPES).not.toContain(WorkerJobType.EXECUTE_POLLING)
            expect(NON_SCHEDULED_JOB_TYPES).not.toContain(WorkerJobType.RENEW_WEBHOOK)
        })
    })

    describe('JobPayload discrimination', () => {
        it('validates inline payload', () => {
            const inline = JobPayload.parse({
                type: 'inline',
                value: { foo: 'bar', count: 123 },
            })
            expect(inline.type).toBe('inline')
            expect((inline as InlineJobPayload).value).toEqual({ foo: 'bar', count: 123 })
        })

        it('validates ref payload with fileId', () => {
            const ref = JobPayload.parse({
                type: 'ref',
                fileId: 'file-blob-999',
            })
            expect(ref.type).toBe('ref')
            expect((ref as RefJobPayload).fileId).toBe('file-blob-999')
        })

        it('rejects invalid payload types', () => {
            expect(() => JobPayload.parse({ type: 'unknown' })).toThrow()
        })
    })

    describe('JobData schemas', () => {
        it('validates PollingJobData schema', () => {
            const data = PollingJobData.parse({
                projectId: 'proj-1',
                platformId: 'plat-1',
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                flowVersionId: 'fv-1',
                flowId: 'flow-1',
                triggerType: FlowTriggerType.PIECE,
                jobType: WorkerJobType.EXECUTE_POLLING,
            })
            expect(data.jobType).toBe(WorkerJobType.EXECUTE_POLLING)
        })

        it('validates RenewWebhookJobData schema', () => {
            const data = RenewWebhookJobData.parse({
                projectId: 'proj-1',
                platformId: 'plat-1',
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                flowVersionId: 'fv-1',
                flowId: 'flow-1',
                jobType: WorkerJobType.RENEW_WEBHOOK,
            })
            expect(data.jobType).toBe(WorkerJobType.RENEW_WEBHOOK)
        })

        it('validates Begin and Resume ExecuteFlowJobData', () => {
            const beginData = ExecuteFlowJobData.parse({
                projectId: 'proj-1',
                platformId: 'plat-1',
                jobType: WorkerJobType.EXECUTE_FLOW,
                executionType: ExecutionType.BEGIN,
                environment: RunEnvironment.PRODUCTION,
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                flowId: 'flow-1',
                flowVersionId: 'fv-1',
                runId: 'run-1',
                payload: { type: 'inline', value: {} },
                streamStepProgress: StreamStepProgress.WEBSOCKET,
                logsFileId: 'log-file-1',
                executeTrigger: true,
            })
            expect(beginData.executionType).toBe(ExecutionType.BEGIN)

            const resumeData = ExecuteFlowJobData.parse({
                projectId: 'proj-1',
                platformId: 'plat-1',
                jobType: WorkerJobType.EXECUTE_FLOW,
                executionType: ExecutionType.RESUME,
                resumeReason: ResumeReason.WAITPOINT,
                environment: RunEnvironment.PRODUCTION,
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                flowId: 'flow-1',
                flowVersionId: 'fv-1',
                runId: 'run-1',
                payload: { type: 'inline', value: {} },
                streamStepProgress: StreamStepProgress.NONE,
                logsFileId: 'log-file-1',
            })
            expect(resumeData.executionType).toBe(ExecutionType.RESUME)
        })

        it('validates WebhookJobData schema', () => {
            const data = WebhookJobData.parse({
                projectId: 'proj-1',
                platformId: 'plat-1',
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                requestId: 'req-1',
                payload: { type: 'inline', value: { body: 'hello' } },
                runEnvironment: RunEnvironment.PRODUCTION,
                flowId: 'flow-1',
                flowVersionIdToRun: 'fv-1',
                saveSampleData: true,
                execute: true,
                jobType: WorkerJobType.EXECUTE_WEBHOOK,
            })
            expect(data.jobType).toBe(WorkerJobType.EXECUTE_WEBHOOK)
        })

        it('validates interactive jobs: property, validation, and token refresh', () => {
            const propJob = ExecutePropertyJobData.parse({
                jobType: WorkerJobType.EXECUTE_PROPERTY,
                projectId: 'proj-1',
                platformId: 'plat-1',
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                propertyName: 'channel',
                piece: mockPiecePackage,
                actionOrTriggerName: 'send_message',
                input: {},
                sampleData: {},
                requestId: 'req-prop',
                webserverId: 'ws-1',
            })
            expect(propJob.propertyName).toBe('channel')

            const valJob = ExecuteValidateAuthJobData.parse({
                jobType: WorkerJobType.EXECUTE_VALIDATION,
                platformId: 'plat-1',
                piece: mockPiecePackage,
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                connectionValue: { apiKey: 'secret' },
                requestId: 'req-val',
                webserverId: 'ws-1',
            })
            expect(valJob.jobType).toBe(WorkerJobType.EXECUTE_VALIDATION)

            const refreshJob = ExecuteTokenRefreshJobData.parse({
                jobType: WorkerJobType.EXECUTE_TOKEN_REFRESH,
                platformId: 'plat-1',
                piece: mockPiecePackage,
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                connectionValue: { type: 'SECRET_TEXT', secret_text: 'token' } as any,
                requestId: 'req-refresh',
                webserverId: 'ws-1',
            })
            expect(refreshJob.jobType).toBe(WorkerJobType.EXECUTE_TOKEN_REFRESH)
        })

        it('validates trigger hook and piece extraction jobs', () => {
            const triggerHookJob = ExecuteTriggerHookJobData.parse({
                jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK,
                platformId: 'plat-1',
                projectId: 'proj-1',
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                test: false,
                hookType: TriggerHookType.ON_ENABLE,
                requestId: 'req-th',
                webserverId: 'ws-1',
            })
            expect(triggerHookJob.hookType).toBe(TriggerHookType.ON_ENABLE)

            const extractJob = ExecuteExtractPieceMetadataJobData.parse({
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                jobType: WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION,
                platformId: 'plat-1',
                piece: mockPiecePackage,
                requestId: 'req-extract',
                webserverId: 'ws-1',
            })
            expect(extractJob.jobType).toBe(WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION)
        })

        it('validates chat agent and event destination jobs', () => {
            const chatJob = ExecuteChatAgentJobData.parse({
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                jobType: WorkerJobType.EXECUTE_CHAT_AGENT,
                conversationId: 'conv-1',
                projectId: 'proj-1',
                platformId: 'plat-1',
                userId: 'user-1',
                userMessage: 'Hello assistant',
                modelName: 'gpt-4o',
            })
            expect(chatJob.userMessage).toBe('Hello assistant')

            const eventJob = EventDestinationJobData.parse({
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                platformId: 'plat-1',
                webhookId: 'wh-1',
                webhookUrl: 'https://example.com/webhook',
                payload: { event: 'flow.created' },
                jobType: WorkerJobType.EVENT_DESTINATION,
            })
            expect(eventJob.webhookUrl).toBe('https://example.com/webhook')
        })

        it('parses correctly through the top-level JobData union', () => {
            const parsed = JobData.parse({
                jobType: WorkerJobType.EXECUTE_POLLING,
                projectId: 'proj-1',
                platformId: 'plat-1',
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                flowVersionId: 'fv-1',
                flowId: 'flow-1',
                triggerType: FlowTriggerType.EMPTY,
            })
            expect(parsed.jobType).toBe(WorkerJobType.EXECUTE_POLLING)
        })
    })
})
