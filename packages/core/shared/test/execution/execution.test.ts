import { describe, expect, it } from 'vitest'
import {
    Execution,
    ExecutionStatus,
    executionUtils,
    TokenUsage,
} from '../../src/lib/execution/execution'
import {
    ExecutionToolCallStatus,
    ToolCall,
    ToolCallError,
    toolCallUtils,
} from '../../src/lib/execution/tool-call'

describe('Execution & ToolCall Domain Contracts', () => {
    describe('executionUtils.isValidExecutionStatusTransition', () => {
        it('allows valid transitions from CREATED state', () => {
            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.CREATED, to: ExecutionStatus.RUNNING })).toBe(true)
            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.CREATED, to: ExecutionStatus.FAILED })).toBe(true)
            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.CREATED, to: ExecutionStatus.CANCELLED })).toBe(true)

            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.CREATED, to: ExecutionStatus.COMPLETED })).toBe(false)
            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.CREATED, to: ExecutionStatus.CREATED })).toBe(false)
        })

        it('allows valid transitions from RUNNING state', () => {
            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.RUNNING, to: ExecutionStatus.COMPLETED })).toBe(true)
            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.RUNNING, to: ExecutionStatus.FAILED })).toBe(true)
            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.RUNNING, to: ExecutionStatus.CANCELLED })).toBe(true)

            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.RUNNING, to: ExecutionStatus.CREATED })).toBe(false)
            expect(executionUtils.isValidExecutionStatusTransition({ from: ExecutionStatus.RUNNING, to: ExecutionStatus.RUNNING })).toBe(false)
        })

        it('treats COMPLETED, FAILED, and CANCELLED as terminal states', () => {
            const terminalStates = [ExecutionStatus.COMPLETED, ExecutionStatus.FAILED, ExecutionStatus.CANCELLED]
            const allStates = Object.values(ExecutionStatus)

            for (const terminal of terminalStates) {
                for (const target of allStates) {
                    expect(executionUtils.isValidExecutionStatusTransition({ from: terminal, to: target })).toBe(false)
                }
            }
        })

        it('returns false for unrecognized state values', () => {
            expect(executionUtils.isValidExecutionStatusTransition({ from: 'INVALID' as any, to: ExecutionStatus.RUNNING })).toBe(false)
        })
    })

    describe('TokenUsage Schema', () => {
        it('validates valid non-negative integer token counts', () => {
            const valid = {
                promptTokens: 150,
                completionTokens: 250,
                totalTokens: 400,
            }
            expect(TokenUsage.parse(valid)).toEqual(valid)
        })

        it('rejects negative token counts', () => {
            expect(() => TokenUsage.parse({
                promptTokens: -1,
                completionTokens: 10,
                totalTokens: 9,
            })).toThrow()
        })

        it('rejects floating-point token numbers', () => {
            expect(() => TokenUsage.parse({
                promptTokens: 10.5,
                completionTokens: 20,
                totalTokens: 30.5,
            })).toThrow()
        })
    })

    describe('Execution Schema', () => {
        const baseExecution = {
            id: 'exec_12345678901234567',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            projectId: 'proj_12345678901234567',
            platformId: 'plat_12345678901234567',
            status: ExecutionStatus.RUNNING,
            prompt: 'Test prompt query',
            metadata: { source: 'api' },
        }

        it('validates a complete execution model', () => {
            const full = {
                ...baseExecution,
                userId: 'user_123',
                tokenUsage: {
                    promptTokens: 10,
                    completionTokens: 20,
                    totalTokens: 30,
                },
                cost: 0.0015,
                finishTime: '2026-01-01T00:01:00.000Z',
            }

            const parsed = Execution.parse(full)
            expect(parsed.id).toBe(baseExecution.id)
            expect(parsed.status).toBe(ExecutionStatus.RUNNING)
            expect(parsed.cost).toBe(0.0015)
        })

        it('allows optional fields to be null or omitted', () => {
            const minimal = {
                ...baseExecution,
                userId: null,
                tokenUsage: null,
                cost: null,
                finishTime: null,
            }

            const parsed = Execution.parse(minimal)
            expect(parsed.userId).toBeNull()
            expect(parsed.tokenUsage).toBeNull()
        })

        it('rejects execution with invalid status value', () => {
            expect(() => Execution.parse({
                ...baseExecution,
                status: 'UNKNOWN_STATUS',
            })).toThrow()
        })
    })

    describe('toolCallUtils.isValidToolCallStatusTransition', () => {
        it('allows valid transitions from PENDING state', () => {
            expect(toolCallUtils.isValidToolCallStatusTransition({ from: ExecutionToolCallStatus.PENDING, to: ExecutionToolCallStatus.RUNNING })).toBe(true)
            expect(toolCallUtils.isValidToolCallStatusTransition({ from: ExecutionToolCallStatus.PENDING, to: ExecutionToolCallStatus.SUCCEEDED })).toBe(true)
            expect(toolCallUtils.isValidToolCallStatusTransition({ from: ExecutionToolCallStatus.PENDING, to: ExecutionToolCallStatus.FAILED })).toBe(true)
            expect(toolCallUtils.isValidToolCallStatusTransition({ from: ExecutionToolCallStatus.PENDING, to: ExecutionToolCallStatus.PENDING })).toBe(false)
        })

        it('allows valid transitions from RUNNING state', () => {
            expect(toolCallUtils.isValidToolCallStatusTransition({ from: ExecutionToolCallStatus.RUNNING, to: ExecutionToolCallStatus.SUCCEEDED })).toBe(true)
            expect(toolCallUtils.isValidToolCallStatusTransition({ from: ExecutionToolCallStatus.RUNNING, to: ExecutionToolCallStatus.FAILED })).toBe(true)

            expect(toolCallUtils.isValidToolCallStatusTransition({ from: ExecutionToolCallStatus.RUNNING, to: ExecutionToolCallStatus.PENDING })).toBe(false)
            expect(toolCallUtils.isValidToolCallStatusTransition({ from: ExecutionToolCallStatus.RUNNING, to: ExecutionToolCallStatus.RUNNING })).toBe(false)
        })

        it('treats SUCCEEDED and FAILED as terminal states', () => {
            const terminalStates = [ExecutionToolCallStatus.SUCCEEDED, ExecutionToolCallStatus.FAILED]
            const allStates = Object.values(ExecutionToolCallStatus)

            for (const terminal of terminalStates) {
                for (const target of allStates) {
                    expect(toolCallUtils.isValidToolCallStatusTransition({ from: terminal, to: target })).toBe(false)
                }
            }
        })
    })

    describe('ToolCall and ToolCallError Schema', () => {
        it('validates a successful tool call', () => {
            const call = {
                id: 'tc_12345678901234567',
                created: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                executionId: 'exec_123',
                projectId: 'proj_123',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '1.0.0',
                actionName: 'send_message',
                connectionId: 'conn_123',
                input: { channel: 'general', text: 'hello' },
                output: { messageId: 'msg_999' },
                status: ExecutionToolCallStatus.SUCCEEDED,
                error: null,
                latencyMs: 124,
                finished: '2026-01-01T00:00:01.000Z',
            }

            const parsed = ToolCall.parse(call)
            expect(parsed.id).toBe('tc_12345678901234567')
            expect(parsed.status).toBe(ExecutionToolCallStatus.SUCCEEDED)
            expect(parsed.latencyMs).toBe(124)
        })

        it('validates a failed tool call with ToolCallError', () => {
            const errorObj = {
                message: 'Rate limit exceeded',
                code: 'RATE_LIMIT',
                stack: 'Error: Rate limit\n    at ...',
            }
            expect(ToolCallError.parse(errorObj)).toEqual(errorObj)

            const call = {
                id: 'tc_failed',
                created: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                executionId: 'exec_123',
                projectId: 'proj_123',
                pieceName: 'piece-http',
                pieceVersion: '1.0.0',
                actionName: 'send_request',
                input: { url: 'https://example.com' },
                status: ExecutionToolCallStatus.FAILED,
                error: errorObj,
            }

            const parsed = ToolCall.parse(call)
            expect(parsed.status).toBe(ExecutionToolCallStatus.FAILED)
            expect(parsed.error?.code).toBe('RATE_LIMIT')
        })
    })
})
