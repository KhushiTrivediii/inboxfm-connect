import { connectErrorFactory, ConnectError } from './errors'

async function withRetry<T>({ fn, shouldRetry, maxAttempts, baseDelayMs, maxDelayMs, signal }: WithRetryOptions<T>): Promise<T> {
    let attempt = 0
    for (;;) {
        try {
            return await fn()
        }
        catch (error) {
            attempt += 1
            const isLastAttempt = attempt >= maxAttempts
            if (isLastAttempt || !shouldRetry(error)) {
                throw error
            }
            const retryAfterMs = error instanceof ConnectError ? error.retryAfterMs : undefined
            const delayMs = retryAfterMs ?? computeBackoffDelay({ attempt, baseDelayMs, maxDelayMs })
            await sleepOrThrowAborted({ delayMs, signal })
        }
    }
}

// A caller aborting while the SDK waits between attempts must still surface as a
// ConnectError, not the raw AbortSignal reason, or `instanceof ConnectError` checks miss it.
async function sleepOrThrowAborted({ delayMs, signal }: { delayMs: number, signal?: AbortSignal }): Promise<void> {
    try {
        await sleep({ delayMs, signal })
    }
    catch {
        throw connectErrorFactory.fromAbort()
    }
}

function computeBackoffDelay({ attempt, baseDelayMs, maxDelayMs }: { attempt: number, baseDelayMs: number, maxDelayMs: number }): number {
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
    return Math.random() * exponential
}

function sleep({ delayMs, signal }: { delayMs: number, signal?: AbortSignal }): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, delayMs)
        function onAbort(): void {
            clearTimeout(timer)
            reject(signal?.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export const retryPolicy = {
    withRetry,
    computeBackoffDelay,
}

export type WithRetryOptions<T> = {
    fn: () => Promise<T>
    shouldRetry: (error: unknown) => boolean
    maxAttempts: number
    baseDelayMs: number
    maxDelayMs: number
    signal?: AbortSignal
}
