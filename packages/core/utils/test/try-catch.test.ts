import { tryCatch, tryCatchSync } from '../src/lib/try-catch'

/**
 * tryCatch/tryCatchSync underpin error handling across the server, the engine and
 * the CLI: every caller branches on `error` being null rather than on a throw.
 * The contract that matters is the discriminated union - data and error are
 * never both set, and a falsy return value is not mistaken for a failure.
 */

describe('tryCatch', () => {
    it('returns the resolved value with a null error', async () => {
        const result = await tryCatch(async () => 'ok')
        expect(result).toEqual({ data: 'ok', error: null })
    })

    it('captures a rejection as the error with null data', async () => {
        const boom = new Error('boom')
        const result = await tryCatch(async () => {
            throw boom
        })
        expect(result.data).toBeNull()
        expect(result.error).toBe(boom)
    })

    it('does not treat a falsy resolved value as a failure', async () => {
        expect(await tryCatch(async () => 0)).toEqual({ data: 0, error: null })
        expect(await tryCatch(async () => '')).toEqual({ data: '', error: null })
        expect(await tryCatch(async () => false)).toEqual({ data: false, error: null })
        expect(await tryCatch(async () => null)).toEqual({ data: null, error: null })
        expect(await tryCatch(async () => undefined)).toEqual({ data: undefined, error: null })
    })

    it('preserves a thrown non-Error value as-is', async () => {
        const result = await tryCatch(async () => {
            throw 'a string rejection'
        })
        expect(result.error).toBe('a string rejection')
    })

    it('waits for the promise before resolving', async () => {
        const result = await tryCatch(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            return 'delayed'
        })
        expect(result.data).toBe('delayed')
    })

    it('captures a synchronous throw inside an async callback', async () => {
        const result = await tryCatch(async () => {
            throw new Error('sync inside async')
        })
        expect(result.error).toBeInstanceOf(Error)
    })
})

describe('tryCatchSync', () => {
    it('returns the value with a null error', () => {
        expect(tryCatchSync(() => 'ok')).toEqual({ data: 'ok', error: null })
    })

    it('captures a throw as the error with null data', () => {
        const boom = new Error('boom')
        const result = tryCatchSync(() => {
            throw boom
        })
        expect(result.data).toBeNull()
        expect(result.error).toBe(boom)
    })

    it('does not treat a falsy return value as a failure', () => {
        expect(tryCatchSync(() => 0)).toEqual({ data: 0, error: null })
        expect(tryCatchSync(() => '')).toEqual({ data: '', error: null })
        expect(tryCatchSync(() => false)).toEqual({ data: false, error: null })
        expect(tryCatchSync(() => null)).toEqual({ data: null, error: null })
        expect(tryCatchSync(() => undefined)).toEqual({ data: undefined, error: null })
    })

    it('preserves a thrown non-Error value as-is', () => {
        expect(tryCatchSync(() => {
            throw 'a string throw'
        }).error).toBe('a string throw')
    })

    it('discriminates on error without inspecting data', () => {
        // The failure branch must be reachable by error alone, because a
        // successful call can legitimately carry null/undefined data.
        const failed = tryCatchSync(() => {
            throw new Error('nope')
        })
        expect(failed.error).not.toBeNull()
        expect(failed.data).toBeNull()

        const succeededWithNull = tryCatchSync(() => null)
        expect(succeededWithNull.error).toBeNull()
    })
})