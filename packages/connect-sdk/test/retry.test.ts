import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectError } from '../src/errors'
import { retryPolicy } from '../src/retry'

function retryableError({ retryAfterMs }: { retryAfterMs?: number } = {}): ConnectError {
    return new ConnectError({ category: 'server', status: 503, retryable: true, retryAfterMs, message: 'unavailable' })
}

describe('retryPolicy.computeBackoffDelay', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('grows exponentially from the base delay and never exceeds the max delay', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.999999)

        const delays = [1, 2, 3, 4, 5, 6].map((attempt) => retryPolicy.computeBackoffDelay({ attempt, baseDelayMs: 100, maxDelayMs: 1_000 }))

        expect(delays[0]).toBeCloseTo(100, 0)
        expect(delays[1]).toBeCloseTo(200, 0)
        expect(delays[2]).toBeCloseTo(400, 0)
        expect(delays[3]).toBeCloseTo(800, 0)
        expect(delays[4]).toBeLessThanOrEqual(1_000)
        expect(delays[5]).toBeLessThanOrEqual(1_000)
    })

    it('applies full jitter, so the delay can be anywhere down to zero', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0)

        expect(retryPolicy.computeBackoffDelay({ attempt: 3, baseDelayMs: 100, maxDelayMs: 1_000 })).toBe(0)
    })
})

describe('retryPolicy.withRetry', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('waits for the server-provided Retry-After instead of the computed backoff', async () => {
        vi.useFakeTimers()
        const fn = vi.fn<() => Promise<string>>()
            .mockRejectedValueOnce(retryableError({ retryAfterMs: 2_000 }))
            .mockResolvedValueOnce('ok')

        const pending = retryPolicy.withRetry({ fn, shouldRetry: () => true, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 })

        await vi.advanceTimersByTimeAsync(1_999)
        expect(fn).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await expect(pending).resolves.toBe('ok')
        expect(fn).toHaveBeenCalledTimes(2)
    })

    it('does not retry when shouldRetry rejects the error', async () => {
        const fn = vi.fn<() => Promise<string>>().mockRejectedValue(retryableError())

        await expect(retryPolicy.withRetry({ fn, shouldRetry: () => false, maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toBeInstanceOf(ConnectError)
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('surfaces a caller abort during the backoff wait as a typed ConnectError, not the raw abort reason', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const fn = vi.fn<() => Promise<string>>().mockRejectedValue(retryableError({ retryAfterMs: 10_000 }))

        const pending = retryPolicy.withRetry({ fn, shouldRetry: () => true, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, signal: controller.signal })
        const assertion = expect(pending).rejects.toMatchObject({ name: 'ConnectError', category: 'aborted', retryable: false })

        await vi.advanceTimersByTimeAsync(100)
        controller.abort()
        await assertion
        expect(fn).toHaveBeenCalledTimes(1)
    })
})
