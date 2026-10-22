import { describe, expect, it } from 'vitest'
import {
    CreateExecutionRequestBody,
    ExecutionResult,
    ListExecutionsRequestQuery,
} from '../../src/lib/execution/dto/execution-requests'
import {
    CreateToolCallRequestBody,
    ListToolCallsRequestParams,
    MarkToolCallFailedRequestBody,
    MarkToolCallRunningRequestBody,
    MarkToolCallSucceededRequestBody,
} from '../../src/lib/execution/dto/tool-call-requests'
import { ExecutionStatus } from '../../src/lib/execution/execution'

describe('Execution & ToolCall DTO Schemas', () => {
    describe('CreateExecutionRequestBody', () => {
        it('parses valid payload and applies default connectionIds and metadata', () => {
            const body = {
                prompt: 'Generate monthly report',
            }

            const parsed = CreateExecutionRequestBody.parse(body)
            expect(parsed.prompt).toBe('Generate monthly report')
            expect(parsed.connectionIds).toEqual([])
            expect(parsed.metadata).toEqual({})
            expect(parsed.projectId).toBeUndefined()
        })

        it('preserves provided optional projectId, connectionIds, and metadata', () => {
            const body = {
                projectId: 'proj_123',
                prompt: 'Process ticket',
                connectionIds: ['conn_abc', 'conn_xyz'],
                metadata: { source: 'webhook', priority: 'high' },
            }

            const parsed = CreateExecutionRequestBody.parse(body)
            expect(parsed.projectId).toBe('proj_123')
            expect(parsed.connectionIds).toEqual(['conn_abc', 'conn_xyz'])
            expect(parsed.metadata).toEqual({ source: 'webhook', priority: 'high' })
        })

        it('rejects empty prompt string', () => {
            expect(() => CreateExecutionRequestBody.parse({ prompt: '' })).toThrow()
        })
    })

    describe('ExecutionResult', () => {
        it('validates a successful execution result', () => {
            const result = {
                executionId: 'exec_123',
                status: ExecutionStatus.COMPLETED,
                output: { summary: 'Sales up 15%' },
                tokenUsage: {
                    promptTokens: 100,
                    completionTokens: 50,
                    totalTokens: 150,
                },
                durationMs: 1250,
            }

            const parsed = ExecutionResult.parse(result)
            expect(parsed.executionId).toBe('exec_123')
            expect(parsed.status).toBe(ExecutionStatus.COMPLETED)
            expect(parsed.output).toEqual({ summary: 'Sales up 15%' })
        })

        it('validates a failed execution result with error details', () => {
            const result = {
                executionId: 'exec_fail',
                status: ExecutionStatus.FAILED,
                error: {
                    message: 'Out of quota',
                    code: 'QUOTA_EXCEEDED',
                },
            }

            const parsed = ExecutionResult.parse(result)
            expect(parsed.status).toBe(ExecutionStatus.FAILED)
            expect(parsed.error?.code).toBe('QUOTA_EXCEEDED')
        })

        it('rejects invalid status', () => {
            expect(() => ExecutionResult.parse({
                executionId: 'exec_invalid',
                status: 'INVALID_STATUS',
            })).toThrow()
        })
    })

    describe('ListExecutionsRequestQuery', () => {
        it('applies default limit of 10 when limit is omitted', () => {
            const query = {}
            const parsed = ListExecutionsRequestQuery.parse(query)
            expect(parsed.limit).toBe(10)
        })

        it('coerces string limit into number and validates within [1, 100]', () => {
            const query = { limit: '50' }
            const parsed = ListExecutionsRequestQuery.parse(query)
            expect(parsed.limit).toBe(50)
        })

        it('rejects limit out of [1, 100] range', () => {
            expect(() => ListExecutionsRequestQuery.parse({ limit: 0 })).toThrow()
            expect(() => ListExecutionsRequestQuery.parse({ limit: -5 })).toThrow()
            expect(() => ListExecutionsRequestQuery.parse({ limit: 101 })).toThrow()
        })

        it('supports optional filter params: projectId, status, and cursor', () => {
            const query = {
                projectId: 'proj_abc',
                status: ExecutionStatus.COMPLETED,
                cursor: 'cur_next_page',
                limit: '20',
            }

            const parsed = ListExecutionsRequestQuery.parse(query)
            expect(parsed.projectId).toBe('proj_abc')
            expect(parsed.status).toBe(ExecutionStatus.COMPLETED)
            expect(parsed.cursor).toBe('cur_next_page')
            expect(parsed.limit).toBe(20)
        })
    })

    describe('ToolCall Requests', () => {
        it('CreateToolCallRequestBody validates required fields', () => {
            const valid = {
                executionId: 'exec_1',
                projectId: 'proj_1',
                pieceName: '@inboxfm-connect/piece-slack',
                pieceVersion: '1.0.0',
                actionName: 'send_channel_message',
                connectionId: 'conn_slack',
                input: { channel: '#general', text: 'hi' },
            }

            const parsed = CreateToolCallRequestBody.parse(valid)
            expect(parsed.pieceName).toBe('@inboxfm-connect/piece-slack')
            expect(parsed.connectionId).toBe('conn_slack')
        })

        it('MarkToolCallRunningRequestBody requires id, executionId, and projectId', () => {
            const body = {
                id: 'tc_1',
                executionId: 'exec_1',
                projectId: 'proj_1',
            }
            expect(MarkToolCallRunningRequestBody.parse(body)).toEqual(body)
            expect(() => MarkToolCallRunningRequestBody.parse({ id: 'tc_1' })).toThrow()
        })

        it('MarkToolCallSucceededRequestBody requires non-negative latencyMs', () => {
            const valid = {
                id: 'tc_1',
                executionId: 'exec_1',
                projectId: 'proj_1',
                output: { ok: true },
                latencyMs: 120,
            }
            expect(MarkToolCallSucceededRequestBody.parse(valid)).toEqual(valid)

            expect(() => MarkToolCallSucceededRequestBody.parse({
                ...valid,
                latencyMs: -10,
            })).toThrow()
        })

        it('MarkToolCallFailedRequestBody requires error and non-negative latencyMs', () => {
            const valid = {
                id: 'tc_1',
                executionId: 'exec_1',
                projectId: 'proj_1',
                error: { message: 'Timed out' },
                latencyMs: 5000,
            }
            expect(MarkToolCallFailedRequestBody.parse(valid)).toEqual(valid)

            expect(() => MarkToolCallFailedRequestBody.parse({
                ...valid,
                error: 'plain string is not an error object',
            })).toThrow()
        })

        it('ListToolCallsRequestParams requires id param', () => {
            expect(ListToolCallsRequestParams.parse({ id: 'exec_123' })).toEqual({ id: 'exec_123' })
            expect(() => ListToolCallsRequestParams.parse({})).toThrow()
        })
    })
})
