import { describe, expect, it, vi } from 'vitest'
import {
    createNotifyClient,
    createNotifyServer,
    createRpcClient,
    createRpcServer,
} from '../../src/lib/engine/rpc'

describe('rpc engine transport', () => {
    describe('createRpcClient and createRpcServer', () => {
        it('successfully executes RPC round-trip over socket', async () => {
            const listeners: Record<string, ((...args: any[]) => void)[]> = {}
            let lastTimeoutMs = 0

            const serverSocket = {
                emit: vi.fn(),
                on: (event: string, fn: (...args: any[]) => void) => {
                    listeners[event] = listeners[event] || []
                    listeners[event].push(fn)
                },
                timeout: vi.fn(),
            }

            const clientSocket = {
                emit: vi.fn(),
                on: vi.fn(),
                timeout: (ms: number) => {
                    lastTimeoutMs = ms
                    return {
                        emitWithAck: async (event: string, msg: any) => {
                            let result: any
                            const serverHandler = listeners[event]?.[0]
                            if (serverHandler) {
                                await serverHandler(msg, (ackResult: any) => {
                                    result = ackResult
                                })
                            }
                            return result
                        },
                    }
                },
            }

            type MathContract = {
                add(input: { a: number, b: number }): Promise<number>
                greet(input: { name: string }): Promise<string>
            }

            const handlers: MathContract = {
                add: async ({ a, b }) => a + b,
                greet: async ({ name }) => `Hello, ${name}!`,
            }

            createRpcServer(serverSocket as any, handlers)
            const client = createRpcClient<MathContract>(clientSocket as any, 5000)

            const sum = await client.add({ a: 10, b: 32 })
            expect(sum).toBe(42)
            expect(lastTimeoutMs).toBe(5000)

            const greeting = await client.greet({ name: 'Antigravity' })
            expect(greeting).toBe('Hello, Antigravity!')
        })

        it('propagates server handler errors as RPC error', async () => {
            const listeners: Record<string, ((...args: any[]) => void)[]> = {}

            const serverSocket = {
                emit: vi.fn(),
                on: (event: string, fn: (...args: any[]) => void) => {
                    listeners[event] = listeners[event] || []
                    listeners[event].push(fn)
                },
                timeout: vi.fn(),
            }

            const clientSocket = {
                emit: vi.fn(),
                on: vi.fn(),
                timeout: (ms: number) => ({
                    emitWithAck: async (event: string, msg: any) => {
                        let result: any
                        const serverHandler = listeners[event]?.[0]
                        if (serverHandler) {
                            await serverHandler(msg, (ackResult: any) => {
                                result = ackResult
                            })
                        }
                        return result
                    },
                }),
            }

            type FailingContract = {
                blowUp(input: { reason: string }): Promise<void>
            }

            const handlers: FailingContract = {
                blowUp: async ({ reason }) => {
                    throw new Error(reason)
                },
            }

            createRpcServer(serverSocket as any, handlers)
            const client = createRpcClient<FailingContract>(clientSocket as any, 1000)

            await expect(client.blowUp({ reason: 'Invalid state reached' })).rejects.toThrow(
                'RPC [blowUp] handler threw: Invalid state reached',
            )
        })

        it('handles non-Error objects thrown by server handlers', async () => {
            const listeners: Record<string, ((...args: any[]) => void)[]> = {}

            const serverSocket = {
                emit: vi.fn(),
                on: (event: string, fn: (...args: any[]) => void) => {
                    listeners[event] = listeners[event] || []
                    listeners[event].push(fn)
                },
                timeout: vi.fn(),
            }

            const clientSocket = {
                emit: vi.fn(),
                on: vi.fn(),
                timeout: () => ({
                    emitWithAck: async (event: string, msg: any) => {
                        let result: any
                        const serverHandler = listeners[event]?.[0]
                        if (serverHandler) {
                            await serverHandler(msg, (ackResult: any) => {
                                result = ackResult
                            })
                        }
                        return result
                    },
                }),
            }

            const handlers = {
                customFail: async () => {
                    // eslint-disable-next-line no-throw-literal
                    throw 'string literal error'
                },
            }

            createRpcServer(serverSocket as any, handlers as any)
            const client = createRpcClient<typeof handlers>(clientSocket as any, 2000)

            await expect(client.customFail()).rejects.toThrow(
                'RPC [customFail] handler threw: string literal error',
            )
        })

        it('formats client timeout error when socket timeout rejects', async () => {
            const clientSocket = {
                emit: vi.fn(),
                on: vi.fn(),
                timeout: (ms: number) => ({
                    emitWithAck: async () => {
                        throw new Error('operation timed out')
                    },
                }),
            }

            type SlowContract = {
                slowMethod(): Promise<string>
            }

            const client = createRpcClient<SlowContract>(clientSocket as any, 3000)

            await expect(client.slowMethod()).rejects.toThrow(
                'RPC [slowMethod] failed (timeout: 3000ms): operation timed out',
            )
        })

        it('formats client timeout error with string error fallback', async () => {
            const clientSocket = {
                emit: vi.fn(),
                on: vi.fn(),
                timeout: (ms: number) => ({
                    emitWithAck: async () => {
                        // eslint-disable-next-line no-throw-literal
                        throw 'socket hang up'
                    },
                }),
            }

            type HangupContract = {
                hangup(): Promise<string>
            }

            const client = createRpcClient<HangupContract>(clientSocket as any, 1500)

            await expect(client.hangup()).rejects.toThrow(
                'RPC [hangup] failed (timeout: 1500ms): socket hang up',
            )
        })
    })

    describe('createNotifyClient and createNotifyServer', () => {
        it('emits notify event from client and executes server handler', () => {
            const listeners: Record<string, ((...args: any[]) => void)[]> = {}

            const socket = {
                emit: (event: string, payload: any) => {
                    listeners[event]?.forEach(fn => fn(payload))
                },
                on: (event: string, fn: (...args: any[]) => void) => {
                    listeners[event] = listeners[event] || []
                    listeners[event].push(fn)
                },
            }

            const received: any[] = []
            type LoggerContract = {
                logMessage(input: { level: string, msg: string }): void
            }

            const handlers: LoggerContract = {
                logMessage: (input) => {
                    received.push(input)
                },
            }

            createNotifyServer(socket as any, handlers)
            const client = createNotifyClient<LoggerContract>(socket as any)

            client.logMessage({ level: 'info', msg: 'step starting' })
            client.logMessage({ level: 'debug', msg: 'memory: 42MB' })

            expect(received).toHaveLength(2)
            expect(received[0]).toEqual({ level: 'info', msg: 'step starting' })
            expect(received[1]).toEqual({ level: 'debug', msg: 'memory: 42MB' })
        })
    })
})
