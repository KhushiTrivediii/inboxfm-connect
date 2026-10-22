import { describe, expect, it } from 'vitest'
import {
    DelayPauseMetadata,
    FAILED_STATES,
    FlowRunStatus,
    isFailedState,
    isFlowRunStateTerminal,
    PauseMetadata,
    PauseType,
    RespondResponse,
    StopResponse,
    WebhookPauseMetadata,
} from '../../src/lib/flow-run/execution/flow-execution'
import {
    ExecutionState,
    ExecutionType,
    ExecutioOutputFile,
    RunInternalError,
    RunInternalErrorSource,
} from '../../src/lib/flow-run/execution/execution-output'
import { logSerializer } from '../../src/lib/flow-run/log-serializer'
import { FLOW_RUN_LOG_MANIFEST_V2, StepOutputStatus } from '../../src/lib/flow-run/execution/step-output'
import { StreamStepProgress } from '../../src/lib/engine/engine-operation'

describe('flow-execution-and-output', () => {
    describe('isFlowRunStateTerminal', () => {
        it('returns true for terminal states', () => {
            const terminalStates = [
                FlowRunStatus.SUCCEEDED,
                FlowRunStatus.TIMEOUT,
                FlowRunStatus.FAILED,
                FlowRunStatus.QUOTA_EXCEEDED,
                FlowRunStatus.MEMORY_LIMIT_EXCEEDED,
                FlowRunStatus.LOG_SIZE_EXCEEDED,
                FlowRunStatus.CANCELED,
            ]

            for (const status of terminalStates) {
                expect(isFlowRunStateTerminal({ status, ignoreInternalError: false })).toBe(true)
                expect(isFlowRunStateTerminal({ status, ignoreInternalError: true })).toBe(true)
            }
        })

        it('returns false for non-terminal active states', () => {
            const nonTerminalStates = [
                FlowRunStatus.QUEUED,
                FlowRunStatus.RUNNING,
                FlowRunStatus.PAUSED,
            ]

            for (const status of nonTerminalStates) {
                expect(isFlowRunStateTerminal({ status, ignoreInternalError: false })).toBe(false)
                expect(isFlowRunStateTerminal({ status, ignoreInternalError: true })).toBe(false)
            }
        })

        it('handles INTERNAL_ERROR depending on ignoreInternalError flag', () => {
            expect(isFlowRunStateTerminal({ status: FlowRunStatus.INTERNAL_ERROR, ignoreInternalError: false })).toBe(true)
            expect(isFlowRunStateTerminal({ status: FlowRunStatus.INTERNAL_ERROR, ignoreInternalError: true })).toBe(false)
        })
    })

    describe('isFailedState and FAILED_STATES', () => {
        it('contains expected failed statuses', () => {
            expect(FAILED_STATES).toEqual([
                FlowRunStatus.FAILED,
                FlowRunStatus.INTERNAL_ERROR,
                FlowRunStatus.QUOTA_EXCEEDED,
                FlowRunStatus.TIMEOUT,
                FlowRunStatus.MEMORY_LIMIT_EXCEEDED,
            ])
        })

        it('correctly classifies failed vs non-failed statuses', () => {
            expect(isFailedState(FlowRunStatus.FAILED)).toBe(true)
            expect(isFailedState(FlowRunStatus.INTERNAL_ERROR)).toBe(true)
            expect(isFailedState(FlowRunStatus.QUOTA_EXCEEDED)).toBe(true)
            expect(isFailedState(FlowRunStatus.TIMEOUT)).toBe(true)
            expect(isFailedState(FlowRunStatus.MEMORY_LIMIT_EXCEEDED)).toBe(true)

            expect(isFailedState(FlowRunStatus.SUCCEEDED)).toBe(false)
            expect(isFailedState(FlowRunStatus.RUNNING)).toBe(false)
            expect(isFailedState(FlowRunStatus.PAUSED)).toBe(false)
            expect(isFailedState(FlowRunStatus.QUEUED)).toBe(false)
            expect(isFailedState(FlowRunStatus.CANCELED)).toBe(false)
        })
    })

    describe('PauseMetadata schemas', () => {
        it('parses valid DelayPauseMetadata', () => {
            const validDelay = {
                type: PauseType.DELAY,
                resumeDateTime: '2026-10-03T18:00:00.000Z',
                requestIdToReply: 'req-reply-1',
                handlerId: 'handler-1',
                streamStepProgress: StreamStepProgress.WEBSOCKET,
            }
            const parsed = DelayPauseMetadata.parse(validDelay)
            expect(parsed.type).toBe(PauseType.DELAY)
            expect(parsed.resumeDateTime).toBe('2026-10-03T18:00:00.000Z')
        })

        it('parses valid WebhookPauseMetadata and nested response', () => {
            const validWebhook = {
                type: PauseType.WEBHOOK,
                requestId: 'req-123',
                response: {
                    status: 200,
                    body: { message: 'received' },
                    headers: { 'content-type': 'application/json' },
                },
            }
            const parsed = WebhookPauseMetadata.parse(validWebhook)
            expect(parsed.type).toBe(PauseType.WEBHOOK)
            expect(parsed.requestId).toBe('req-123')
            expect(parsed.response.status).toBe(200)
        })

        it('discriminates union in PauseMetadata', () => {
            const delayResult = PauseMetadata.safeParse({
                type: PauseType.DELAY,
                resumeDateTime: '2026-10-03T20:00:00.000Z',
            })
            expect(delayResult.success).toBe(true)

            const webhookResult = PauseMetadata.safeParse({
                type: PauseType.WEBHOOK,
                requestId: 'req-abc',
                response: { status: 204 },
            })
            expect(webhookResult.success).toBe(true)

            const invalidResult = PauseMetadata.safeParse({
                type: 'UNKNOWN_PAUSE',
            })
            expect(invalidResult.success).toBe(false)
        })

        it('validates RespondResponse and StopResponse schemas', () => {
            const res = RespondResponse.parse({
                status: 201,
                body: { created: true },
                headers: { authorization: 'bearer test' },
            })
            expect(res.status).toBe(201)

            const stop = StopResponse.parse({
                status: 400,
                body: 'stopped',
            })
            expect(stop.status).toBe(400)
        })
    })

    describe('ExecutionState and RunInternalError', () => {
        it('validates ExecutionType enum values', () => {
            expect(ExecutionType.BEGIN).toBe('BEGIN')
            expect(ExecutionType.RESUME).toBe('RESUME')
        })

        it('parses ExecutionState with steps and tags', () => {
            const state = ExecutionState.parse({
                steps: {
                    step_1: { status: StepOutputStatus.SUCCEEDED, output: 'result' },
                },
                tags: ['production', 'order-flow'],
            })
            expect(state.tags).toEqual(['production', 'order-flow'])
            expect(state.steps['step_1']).toBeDefined()
        })

        it('parses RunInternalError with ENGINE or WORKER sources', () => {
            const engineErr = RunInternalError.parse({
                source: RunInternalErrorSource.ENGINE,
                message: 'Out of memory in sandbox',
                code: 'SANDBOX_OOM',
                occurredAt: '2026-10-03T10:00:00.000Z',
            })
            expect(engineErr.source).toBe(RunInternalErrorSource.ENGINE)

            const workerErr = RunInternalError.parse({
                source: RunInternalErrorSource.WORKER,
                message: 'Heartbeat lost',
                occurredAt: '2026-10-03T10:05:00.000Z',
            })
            expect(workerErr.source).toBe(RunInternalErrorSource.WORKER)
            expect(workerErr.code).toBeUndefined()
        })
    })

    describe('logSerializer', () => {
        it('serializes output file and injects FLOW_RUN_LOG_MANIFEST_V2 when version is omitted', async () => {
            const log: ExecutioOutputFile = {
                executionState: {
                    steps: {},
                    tags: ['test'],
                },
            }

            const buffer = await logSerializer.serialize(log)
            expect(Buffer.isBuffer(buffer)).toBe(true)

            const parsed = JSON.parse(buffer.toString('utf-8'))
            expect(parsed.version).toBe(FLOW_RUN_LOG_MANIFEST_V2)
            expect(parsed.executionState.tags).toEqual(['test'])
        })

        it('preserves existing version if specified', async () => {
            const log: ExecutioOutputFile = {
                version: 99,
                executionState: {
                    steps: {},
                    tags: [],
                },
            }

            const buffer = await logSerializer.serialize(log)
            const parsed = JSON.parse(buffer.toString('utf-8'))
            expect(parsed.version).toBe(99)
        })
    })
})
