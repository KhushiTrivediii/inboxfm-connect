import { EngineResponseStatus } from '@inboxfm-connect/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

// Per-box record of what the mocked manager did: acquire is synchronous, execute
// returns a promise the test controls so we can observe whether a second
// operation is started while the first is still in flight.
type BoxCalls = {
    acquireCount: number
    executeStarted: Array<Deferred<{ status: string, response: unknown }>>
    releaseCount: number
    invalidateCount: number
}

const boxCalls = new Map<number, BoxCalls>()

vi.mock('@inboxfm-connect/server-utils', async (importActual) => {
    const actual = await importActual<typeof import('@inboxfm-connect/server-utils')>()
    return {
        ...actual,
        wideEvent: {
            ...actual.wideEvent,
            timed: vi.fn(({ fn }: { fn: () => unknown }) => fn()),
        },
    }
})

vi.mock('../../../src/lib/cache/local-execution-cache', () => ({
    localExecutionCache: () => ({ provision: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('../../../src/lib/sandbox-manager', () => ({
    createSandboxManager: vi.fn(({ boxId }: { boxId: number }) => {
        const calls: BoxCalls = {
            acquireCount: 0,
            executeStarted: [],
            releaseCount: 0,
            invalidateCount: 0,
        }
        boxCalls.set(boxId, calls)
        return {
            acquire: () => {
                calls.acquireCount += 1
                const deferred = createDeferred<{ status: string, response: unknown }>()
                calls.executeStarted.push(deferred)
                return {
                    id: `sandbox-${boxId}`,
                    start: vi.fn().mockResolvedValue(undefined),
                    execute: () => deferred.promise,
                }
            },
            release: vi.fn().mockImplementation(async () => {
                calls.releaseCount += 1
            }),
            invalidate: vi.fn().mockImplementation(async () => {
                calls.invalidateCount += 1
            }),
            shutdown: vi.fn().mockResolvedValue(undefined),
            getActiveSandbox: vi.fn(() => null),
        }
    }),
}))

import { createSandboxRuntime } from '../../../src/lib/sandbox'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never

function buildExecuteParams(workerIndex: number) {
    return {
        workerIndex,
        log,
        operationType: 'EXECUTE_TOOL',
        operation: {},
        timeoutInSeconds: 60,
        provision: {
            platformId: 'p1',
            pieces: [],
            codes: [],
            publicApiUrl: 'http://localhost/api/',
            engineToken: 't',
        },
    } as never
}

function callsFor(boxId: number): BoxCalls {
    return boxCalls.get(boxId)!
}

describe('createSandboxRuntime per-box serialization', () => {
    beforeEach(() => {
        boxCalls.clear()
        vi.clearAllMocks()
    })

    it('does not start a second operation on a busy box until the first settles', async () => {
        const runtime = createSandboxRuntime({ concurrency: 2, basePath: '/tmp', getSettings: () => ({} as never) })

        const first = runtime.execute(buildExecuteParams(0))
        const second = runtime.execute(buildExecuteParams(0))

        // The first execute owns box 1; the second must be queued behind it.
        await vi.waitFor(() => expect(callsFor(1).executeStarted.length).toBe(1))
        expect(callsFor(1).acquireCount).toBe(1)
        expect(callsFor(1).executeStarted.length).toBe(1)

        callsFor(1).executeStarted[0].resolve({ status: EngineResponseStatus.OK, response: { n: 1 } })
        await expect(first).resolves.toEqual(
            expect.objectContaining({ status: EngineResponseStatus.OK, response: { n: 1 }, timings: expect.anything() }),
        )

        await vi.waitFor(() => expect(callsFor(1).executeStarted.length).toBe(2))
        callsFor(1).executeStarted[1].resolve({ status: EngineResponseStatus.OK, response: { n: 2 } })
        await expect(second).resolves.toEqual(
            expect.objectContaining({ status: EngineResponseStatus.OK, response: { n: 2 } }),
        )

        expect(callsFor(1).releaseCount).toBe(2)
        expect(callsFor(1).invalidateCount).toBe(0)
    })

    it('still runs different boxes concurrently', async () => {
        const runtime = createSandboxRuntime({ concurrency: 2, basePath: '/tmp', getSettings: () => ({} as never) })

        const first = runtime.execute(buildExecuteParams(0))
        const second = runtime.execute(buildExecuteParams(1))

        // Both boxes start their operation without waiting on each other.
        await vi.waitFor(() => {
            expect(callsFor(1).executeStarted.length).toBe(1)
            expect(callsFor(2).executeStarted.length).toBe(1)
        })

        callsFor(1).executeStarted[0].resolve({ status: EngineResponseStatus.OK, response: 'box1' })
        callsFor(2).executeStarted[0].resolve({ status: EngineResponseStatus.OK, response: 'box2' })

        await expect(first).resolves.toEqual(expect.objectContaining({ response: 'box1' }))
        await expect(second).resolves.toEqual(expect.objectContaining({ response: 'box2' }))
    })

    it('keeps the box usable after a thrown operation (queue tail never rejects)', async () => {
        const runtime = createSandboxRuntime({ concurrency: 1, basePath: '/tmp', getSettings: () => ({} as never) })

        const failing = runtime.execute(buildExecuteParams(0))
        const following = runtime.execute(buildExecuteParams(0))

        await vi.waitFor(() => expect(callsFor(1).executeStarted.length).toBe(1))
        callsFor(1).executeStarted[0].reject(new Error('sandbox crashed'))
        await expect(failing).rejects.toThrow('sandbox crashed')
        // The failed operation invalidates the box, as the real manager contract does.
        expect(callsFor(1).invalidateCount).toBe(1)

        await vi.waitFor(() => expect(callsFor(1).executeStarted.length).toBe(2))
        callsFor(1).executeStarted[1].resolve({ status: EngineResponseStatus.OK, response: 'after failure' })
        await expect(following).resolves.toEqual(expect.objectContaining({ response: 'after failure' }))
    })
})
