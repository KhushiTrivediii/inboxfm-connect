import { describe, expect, it } from 'vitest'
import {
    CRITICAL_EXECUTION_EVENT_TYPES,
    ExecutionCancelledPayload,
    ExecutionCompletedPayload,
    ExecutionEvent,
    ExecutionEventType,
    ExecutionFailedPayload,
    ExecutionStartedPayload,
    PlannerStartedPayload,
    ToolFailedPayload,
    ToolFinishedPayload,
    ToolStartedPayload,
} from '../../src/lib/execution/execution-event'

describe('ExecutionEvent Contracts & Payloads', () => {
    describe('CRITICAL_EXECUTION_EVENT_TYPES', () => {
        it('includes all terminal and lifecycle-critical events', () => {
            expect(CRITICAL_EXECUTION_EVENT_TYPES).toContain(ExecutionEventType.ExecutionStarted)
            expect(CRITICAL_EXECUTION_EVENT_TYPES).toContain(ExecutionEventType.ExecutionCompleted)
            expect(CRITICAL_EXECUTION_EVENT_TYPES).toContain(ExecutionEventType.ExecutionFailed)
            expect(CRITICAL_EXECUTION_EVENT_TYPES).toContain(ExecutionEventType.ExecutionCancelled)
            expect(CRITICAL_EXECUTION_EVENT_TYPES).toContain(ExecutionEventType.ToolFailed)
        })

        it('excludes verbose intermediate progress events from critical set', () => {
            expect(CRITICAL_EXECUTION_EVENT_TYPES).not.toContain(ExecutionEventType.ToolStarted)
            expect(CRITICAL_EXECUTION_EVENT_TYPES).not.toContain(ExecutionEventType.ToolFinished)
            expect(CRITICAL_EXECUTION_EVENT_TYPES).not.toContain(ExecutionEventType.PlannerStarted)
        })
    })

    describe('Event Payloads Validation', () => {
        it('validates ExecutionStartedPayload', () => {
            const payload = {
                executionId: 'exec_01',
                prompt: 'Analyze data',
                timestamp: '2026-01-01T00:00:00.000Z',
            }
            expect(ExecutionStartedPayload.parse(payload)).toEqual(payload)
        })

        it('validates PlannerStartedPayload', () => {
            const payload = {
                executionId: 'exec_01',
                model: 'gpt-4o',
                timestamp: '2026-01-01T00:00:00.500Z',
            }
            expect(PlannerStartedPayload.parse(payload)).toEqual(payload)
        })

        it('validates ToolStartedPayload', () => {
            const payload = {
                executionId: 'exec_01',
                toolCallId: 'tc_01',
                pieceName: '@inboxfm-connect/piece-slack',
                actionName: 'send_message',
                input: { message: 'hello' },
            }
            expect(ToolStartedPayload.parse(payload)).toEqual(payload)
        })

        it('validates ToolFinishedPayload', () => {
            const payload = {
                executionId: 'exec_01',
                toolCallId: 'tc_01',
                output: { ok: true },
                latencyMs: 85,
            }
            expect(ToolFinishedPayload.parse(payload)).toEqual(payload)
        })

        it('validates ToolFailedPayload', () => {
            const payload = {
                executionId: 'exec_01',
                toolCallId: 'tc_01',
                error: {
                    message: 'Network error',
                    code: 'TIMEOUT',
                },
            }
            expect(ToolFailedPayload.parse(payload)).toEqual(payload)
        })

        it('validates ExecutionCompletedPayload', () => {
            const payload = {
                executionId: 'exec_01',
                output: { summary: 'done' },
                totalTokens: 1200,
                durationMs: 4500,
            }
            expect(ExecutionCompletedPayload.parse(payload)).toEqual(payload)
        })

        it('validates ExecutionFailedPayload', () => {
            const payload = {
                executionId: 'exec_01',
                error: {
                    message: 'Context window exceeded',
                    code: 'CONTEXT_LENGTH_EXCEEDED',
                },
            }
            expect(ExecutionFailedPayload.parse(payload)).toEqual(payload)
        })

        it('validates ExecutionCancelledPayload', () => {
            const payload = {
                executionId: 'exec_01',
                reason: 'User cancelled through dashboard',
            }
            expect(ExecutionCancelledPayload.parse(payload)).toEqual(payload)
        })

        it('validates full ExecutionEvent envelope', () => {
            const event = {
                id: 'evt_123',
                executionId: 'exec_01',
                type: ExecutionEventType.ExecutionStarted,
                timestamp: '2026-01-01T00:00:00.000Z',
                payload: { prompt: 'Run task' },
            }
            expect(ExecutionEvent.parse(event)).toEqual(event)
        })
    })
})
