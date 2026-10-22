import { FastifyBaseLogger } from 'fastify'
import Redis from 'ioredis'
import RedLock from 'redlock'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockRedis = {
    quit: vi.fn().mockResolvedValue(undefined),
} as unknown as Redis

const mockRedLock = {
    using: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
} as unknown as RedLock

vi.mock('ioredis', () => ({
    __esModule: true,
    default: vi.fn().mockImplementation(() => mockRedis),
}))

vi.mock('redlock', () => ({
    __esModule: true,
    default: vi.fn().mockImplementation(() => mockRedLock),
}))

vi.mock('async-mutex', () => ({
    Mutex: class {
        async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
            return fn()
        }
    },
}))

import { distributedLockFactory } from '../../../../../src/app/database/redis/distributed-lock-factory'

describe('distributedLockFactory', () => {
    const mockLog: FastifyBaseLogger = {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(),
    } as unknown as FastifyBaseLogger

    beforeEach(() => {
        vi.restoreAllMocks()
        vi.mocked(RedLock).mockImplementation(() => mockRedLock)
        mockRedLock.using.mockImplementation(async (_keys: unknown, _timeout: unknown, _opts: unknown, fn: () => Promise<unknown>) => fn())
        mockRedLock.quit.mockResolvedValue(undefined)
    })

    it('creates a runExclusive function that executes fn', async () => {
        const createRedisConnection = vi.fn().mockResolvedValue(mockRedis)
        const lock = distributedLockFactory(createRedisConnection)

        let executed = false
        const result = await lock(mockLog).runExclusive({
            key: 'test-lock',
            timeoutInSeconds: 10,
            fn: async () => {
                executed = true
                return 'success'
            },
        })

        expect(executed).toBe(true)
        expect(result).toBe('success')
    })

    it('passes correct parameters to RedLock.using', async () => {
        const createRedisConnection = vi.fn().mockResolvedValue(mockRedis)
        const lock = distributedLockFactory(createRedisConnection)

        await lock(mockLog).runExclusive({
            key: 'test-key',
            timeoutInSeconds: 30,
            fn: async () => 'result',
        })

        expect(mockRedLock.using).toHaveBeenCalledWith(
            ['test-key'],
            30000,
            expect.objectContaining({
                retryCount: 150,
                retryDelay: 200,
                automaticExtensionThreshold: 2000,
                driftFactor: 0.01,
            }),
            expect.any(Function)
        )
    })

    it('destroys redlock on destroy call', async () => {
        const createRedisConnection = vi.fn().mockResolvedValue(mockRedis)
        const lock = distributedLockFactory(createRedisConnection)

        await lock(mockLog).runExclusive({ key: 'test', timeoutInSeconds: 10, fn: async () => 'done' })
        await lock(mockLog).destroy()

        expect(mockRedLock.quit).toHaveBeenCalled()
    })

    it('reuses RedLock instance on subsequent calls', async () => {
        const createRedisConnection = vi.fn().mockResolvedValue(mockRedis)
        const lock = distributedLockFactory(createRedisConnection)

        await lock(mockLog).runExclusive({ key: 'a', timeoutInSeconds: 10, fn: async () => 1 })
        await lock(mockLog).runExclusive({ key: 'b', timeoutInSeconds: 10, fn: async () => 2 })

        expect(RedLock).toHaveBeenCalledTimes(1)
    })
})
