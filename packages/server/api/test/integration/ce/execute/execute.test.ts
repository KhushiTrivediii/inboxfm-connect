import { apId } from '@inboxfm-connect/core-utils'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { db } from '../../../helpers/db'
import { describeWithAuth } from '../../../helpers/describe-with-auth'
import { createMockConnection } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import {
    setupTestEnvironment,
    teardownTestEnvironment,
} from '../../../helpers/test-setup'

/**
 * The HeadlessRuntime is instantiated at module scope inside execute.controller.ts.
 * Its `execute()` method calls into the sandbox runtime which requires real piece
 * packages — not available in the test environment. We intercept `HeadlessRuntime`
 * so that `runtime.execute()` can be controlled per test via `executeSpy`.
 */
const { mockExecuteFn } = vi.hoisted(() => ({
    mockExecuteFn: vi.fn(),
}))

vi.mock('@inboxfm-connect/runtime', () => {
    return {
        HeadlessRuntime: vi.fn().mockImplementation(() => ({
            execute: mockExecuteFn,
        })),
    }
})

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(() => {
    mockExecuteFn.mockReset()
})

describe('Execute API (/v1/execute)', () => {
    describeWithAuth(
        'POST /v1/execute (connectionId path)',
        () => app!,
        (setup) => {
            it('should execute a piece action and return the runtime result', async () => {
                const ctx = await setup()

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '0.5.0',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                const expectedOutput = { ok: true, ts: '1234567890.123456' }
                mockExecuteFn.mockResolvedValueOnce(expectedOutput)

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-slack',
                    tool: 'send_message',
                    connectionId: connection.id,
                    input: { channel: '#general', text: 'hello' },
                })

                expect(response?.statusCode).toBe(StatusCodes.OK)
                expect(response?.json()).toEqual(expectedOutput)

                expect(mockExecuteFn).toHaveBeenCalledOnce()
                expect(mockExecuteFn).toHaveBeenCalledWith(
                    expect.objectContaining({
                        integration: '@inboxfm-connect/piece-slack',
                        tool: 'send_message',
                        connectionId: connection.id,
                        projectId: ctx.project.id,
                        platformId: ctx.platform.id,
                    }),
                )
            })

            it('should return 400 when the runtime throws', async () => {
                const ctx = await setup()

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-gmail',
                        pieceVersion: '0.3.0',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                mockExecuteFn.mockRejectedValueOnce(
                    new Error('Sandbox timeout exceeded'),
                )

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-gmail',
                    tool: 'send_email',
                    connectionId: connection.id,
                    input: { to: 'user@example.com', body: 'test' },
                })

                expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
                const body = response?.json()
                expect(body.code).toBe('ENGINE_OPERATION_FAILURE')
                expect(body.params.message).toBe('Sandbox timeout exceeded')
            })

            it('should return 400 when the runtime throws non-Error with fallback message', async () => {
                const ctx = await setup()

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-gmail',
                        pieceVersion: '0.3.0',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                mockExecuteFn.mockRejectedValueOnce('raw string sandbox failure')

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-gmail',
                    tool: 'send_email',
                    connectionId: connection.id,
                    input: { to: 'user@example.com', body: 'test' },
                })

                expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
                const body = response?.json()
                expect(body.code).toBe('ENGINE_OPERATION_FAILURE')
                expect(body.params.message).toBe('Failed to execute piece action')
            })

            it('should return 404 ENTITY_NOT_FOUND when connectionId belongs to another project and not call runtime', async () => {
                const ctx = await setup()
                const otherProject = await createTestContext(app!)

                const foreignConnection = createMockConnection(
                    {
                        platformId: otherProject.platform.id,
                        projectIds: [otherProject.project.id],
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '0.5.0',
                    },
                    otherProject.user.id,
                )
                await db.save('app_connection', foreignConnection)

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-slack',
                    tool: 'send_message',
                    connectionId: foreignConnection.id,
                    input: { channel: '#general', text: 'hello' },
                })

                expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
                const body = response?.json()
                expect(body?.code).toBe('ENTITY_NOT_FOUND')
                expect(mockExecuteFn).not.toHaveBeenCalled()
            })

            it('should return 404 ENTITY_NOT_FOUND when connectionId exists in-project but externalUserId names a different customer and not call runtime', async () => {
                const ctx = await setup()

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '0.5.0',
                        externalId: 'customer-alice',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-slack',
                    tool: 'send_message',
                    connectionId: connection.id,
                    externalUserId: 'customer-bob',
                    input: { channel: '#general', text: 'hello' },
                })

                expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
                const body = response?.json()
                expect(body?.code).toBe('ENTITY_NOT_FOUND')
                expect(mockExecuteFn).not.toHaveBeenCalled()
            })

            it('should return 404 ENTITY_NOT_FOUND when connection exists in-project but for a different piece and not call runtime', async () => {
                const ctx = await setup()

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '0.5.0',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-gmail',
                    tool: 'send_email',
                    connectionId: connection.id,
                    input: {},
                })

                expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
                const body = response?.json()
                expect(body?.code).toBe('ENTITY_NOT_FOUND')
                expect(mockExecuteFn).not.toHaveBeenCalled()
            })
        },
    )

    describeWithAuth(
        'POST /v1/execute (externalUserId path)',
        () => app!,
        (setup) => {
            it('should resolve connectionId from externalUserId + pieceName', async () => {
                const ctx = await setup()
                const externalUserId = `ext-user-${apId()}`

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-notion',
                        externalId: externalUserId,
                        pieceVersion: '0.2.0',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                mockExecuteFn.mockResolvedValueOnce({ pages: [] })

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-notion',
                    tool: 'list_pages',
                    externalUserId,
                    input: {},
                })

                expect(response?.statusCode).toBe(StatusCodes.OK)
                expect(mockExecuteFn).toHaveBeenCalledWith(
                    expect.objectContaining({
                        connectionId: connection.id,
                    }),
                )
            })

            it('should return 404 when no connection matches externalUserId + pieceName', async () => {
                const ctx = await setup()

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-notion',
                    tool: 'list_pages',
                    externalUserId: 'nonexistent-user-id',
                    input: {},
                })

                expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
                const body = response?.json()
                expect(body.code).toBe('ENTITY_NOT_FOUND')
            })
        },
    )

    describeWithAuth(
        'POST /v1/execute (validation errors)',
        () => app!,
        (setup) => {
            it('should return 409 when neither connectionId nor externalUserId is provided', async () => {
                const ctx = await setup()

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-slack',
                    tool: 'send_message',
                    input: { channel: '#general', text: 'hello' },
                })

                expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
                const body = response?.json()
                expect(body.code).toBe('VALIDATION')
                expect(body.params.message).toContain('connectionId')
                expect(body.params.message).toContain('externalUserId')
            })

            it('should return 400 when required body fields are missing', async () => {
                const ctx = await setup()

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                })

                expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            })
        },
    )

    describe('POST /v1/execute (cross-project isolation)', () => {
        it('should reject execution when the requesting user belongs to a different project', async () => {
            const ctx1 = await createTestContext(app!)
            const ctx2 = await createTestContext(app!)

            const connection = createMockConnection(
                {
                    platformId: ctx1.platform.id,
                    projectIds: [ctx1.project.id],
                    pieceName: '@inboxfm-connect/piece-slack',
                    pieceVersion: '0.5.0',
                },
                ctx1.user.id,
            )
            await db.save('app_connection', connection)

            mockExecuteFn.mockResolvedValueOnce({ ok: true })

            // ctx2 tries to execute against ctx1's project
            const response = await ctx2.post('/v1/execute', {
                projectId: ctx1.project.id,
                integration: '@inboxfm-connect/piece-slack',
                tool: 'send_message',
                connectionId: connection.id,
                input: { channel: '#general', text: 'sneaky' },
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(mockExecuteFn).not.toHaveBeenCalled()
        })

        it('should reject when externalUserId lookup targets a foreign project', async () => {
            const ctx1 = await createTestContext(app!)
            const ctx2 = await createTestContext(app!)
            const externalUserId = `ext-cross-${apId()}`

            const connection = createMockConnection(
                {
                    platformId: ctx1.platform.id,
                    projectIds: [ctx1.project.id],
                    pieceName: '@inboxfm-connect/piece-notion',
                    externalId: externalUserId,
                    pieceVersion: '0.2.0',
                },
                ctx1.user.id,
            )
            await db.save('app_connection', connection)

            // ctx2 tries to execute against ctx1's project via externalUserId
            const response = await ctx2.post('/v1/execute', {
                projectId: ctx1.project.id,
                integration: '@inboxfm-connect/piece-notion',
                tool: 'list_pages',
                externalUserId,
                input: {},
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(mockExecuteFn).not.toHaveBeenCalled()
        })
    })

    describe('POST /v1/execute (unauthenticated)', () => {
        it('should reject requests without a bearer token', async () => {
            const response = await app!.inject({
                method: 'POST',
                url: '/api/v1/execute',
                body: {
                    integration: '@inboxfm-connect/piece-slack',
                    tool: 'send_message',
                    connectionId: apId(),
                    input: {},
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })

    describeWithAuth(
        'POST /v1/execute (concurrent calls execute independently - no dedup)',
        () => app!,
        (setup) => {
            it('should handle concurrent execute calls independently', async () => {
                const ctx = await setup()

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '0.5.0',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                let callCount = 0
                mockExecuteFn.mockImplementation(async () => {
                    callCount++
                    // Simulate some execution time
                    await new Promise((resolve) => setTimeout(resolve, 50))
                    return { result: callCount }
                })

                const executePayload = {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-slack',
                    tool: 'send_message',
                    connectionId: connection.id,
                    input: { channel: '#general', text: 'hello' },
                }

                const [r1, r2] = await Promise.all([
                    ctx.post('/v1/execute', executePayload),
                    ctx.post('/v1/execute', executePayload),
                ])

                expect(r1?.statusCode).toBe(StatusCodes.OK)
                expect(r2?.statusCode).toBe(StatusCodes.OK)
                // Both calls should have been dispatched (no server-side dedup on execute)
                expect(mockExecuteFn).toHaveBeenCalledTimes(2)
            })
        },
    )

    describeWithAuth(
        'POST /v1/execute (runtime result passthrough)',
        () => app!,
        (setup) => {
            it('should pass through complex nested runtime output unchanged', async () => {
                const ctx = await setup()

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-google-sheets',
                        pieceVersion: '1.0.0',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                const complexOutput = {
                    spreadsheetId: 'abc123',
                    updatedRange: 'Sheet1!A1:C3',
                    updatedRows: 3,
                    updatedColumns: 3,
                    updatedCells: 9,
                    updatedData: {
                        range: 'Sheet1!A1:C3',
                        majorDimension: 'ROWS',
                        values: [
                            ['Name', 'Age', 'City'],
                            ['Alice', '30', 'NYC'],
                            ['Bob', '25', 'LA'],
                        ],
                    },
                }
                mockExecuteFn.mockResolvedValueOnce(complexOutput)

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-google-sheets',
                    tool: 'update_values',
                    connectionId: connection.id,
                    input: { spreadsheetId: 'abc123', range: 'Sheet1!A1:C3' },
                })

                expect(response?.statusCode).toBe(StatusCodes.OK)
                expect(response?.json()).toEqual(complexOutput)
            })

            it('should handle null runtime output gracefully and serialize null', async () => {
                const ctx = await setup()

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '0.5.0',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                mockExecuteFn.mockResolvedValueOnce(null)

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-slack',
                    tool: 'send_message',
                    connectionId: connection.id,
                    input: { channel: '#general', text: 'hello' },
                })

                expect(response?.statusCode).toBe(StatusCodes.OK)
                expect(response?.json()).toBeNull()
            })

            it('should handle undefined runtime output gracefully with empty body', async () => {
                const ctx = await setup()

                const connection = createMockConnection(
                    {
                        platformId: ctx.platform.id,
                        projectIds: [ctx.project.id],
                        pieceName: '@inboxfm-connect/piece-slack',
                        pieceVersion: '0.5.0',
                    },
                    ctx.user.id,
                )
                await db.save('app_connection', connection)

                mockExecuteFn.mockResolvedValueOnce(undefined)

                const response = await ctx.post('/v1/execute', {
                    projectId: ctx.project.id,
                    integration: '@inboxfm-connect/piece-slack',
                    tool: 'send_message',
                    connectionId: connection.id,
                    input: { channel: '#general', text: 'hello' },
                })

                expect(response?.statusCode).toBe(StatusCodes.OK)
                expect(response?.body).toBe('')
            })
        },
    )
})
