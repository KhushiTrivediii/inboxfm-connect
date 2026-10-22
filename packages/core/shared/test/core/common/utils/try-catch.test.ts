import { tryCatch, tryCatchSync } from '@inboxfm-connect/core-utils'
import { describe, expect, it } from 'vitest'

describe('tryCatch and tryCatchSync (Issue #141)', () => {
    describe('tryCatchSync', () => {
        it('returns data when function executes successfully without error', () => {
            const result = tryCatchSync(() => 42)
            expect(result.error).toBeNull()
            expect(result.data).toBe(42)
        })

        it('returns error when function throws an Error instance', () => {
            const testError = new Error('Sync execution failed')
            const result = tryCatchSync(() => {
                throw testError
            })
            expect(result.data).toBeNull()
            expect(result.error).toBe(testError)
        })

        it('passes through non-Error thrown values without mutation', () => {
            const result = tryCatchSync<never, string>(() => {
                throw 'string error message'
            })
            expect(result.data).toBeNull()
            expect(result.error).toBe('string error message')
        })

        it('safely handles JSON parsing success and failure', () => {
            const valid = tryCatchSync(() => JSON.parse('{"status":"ok"}'))
            expect(valid.error).toBeNull()
            expect(valid.data).toEqual({ status: 'ok' })

            const invalid = tryCatchSync(() => JSON.parse('{bad json}'))
            expect(invalid.data).toBeNull()
            expect(invalid.error).toBeInstanceOf(Error)
        })
    })

    describe('tryCatch', () => {
        it('returns data when async promise resolves successfully', async () => {
            const result = await tryCatch(async () => {
                return 'async resolved value'
            })
            expect(result.error).toBeNull()
            expect(result.data).toBe('async resolved value')
        })

        it('returns error when async promise rejects with an Error', async () => {
            const testError = new Error('Async rejection')
            const result = await tryCatch(async () => {
                throw testError
            })
            expect(result.data).toBeNull()
            expect(result.error).toBe(testError)
        })

        it('passes through non-Error rejected values without mutation', async () => {
            const result = await tryCatch<never, string>(async () => {
                return Promise.reject('non-error rejection')
            })
            expect(result.data).toBeNull()
            expect(result.error).toBe('non-error rejection')
        })
    })
})
