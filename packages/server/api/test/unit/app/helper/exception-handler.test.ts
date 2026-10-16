import * as Sentry from '@sentry/node'
import { describe, expect, it } from 'vitest'
import { exceptionHandler } from '../../../../src/app/helper/exception-handler'

// initializeSentry installs beforeSend on the Sentry client; it is the only
// surface that can be exercised without shipping a real event to Sentry.
const getBeforeSend = () => Sentry.getCurrentHub().getClient()?.getOptions()?.beforeSend

const init = () => exceptionHandler.initializeSentry('https://public@sentry.example.com/1')

describe('exceptionHandler.initializeSentry beforeSend', () => {
    it('does not throw when the exception carries an empty values array', () => {
        init()
        const beforeSend = getBeforeSend()
        expect(beforeSend).toBeTypeOf('function')

        // Regression: `values?.[0].type` threw a TypeError inside Sentry's
        // event pipeline whenever the first exception frame list was empty.
        const event: Sentry.Event = { exception: { values: [] } }
        expect(() => beforeSend?.(event)).not.toThrow()
        expect(beforeSend?.(event)).toBe(event)
    })

    it('does not throw when the exception has no values at all', () => {
        init()
        const beforeSend = getBeforeSend()
        const event: Sentry.Event = { exception: {} }
        expect(() => beforeSend?.(event)).not.toThrow()
        expect(beforeSend?.(event)).toBe(event)
    })

    it('still drops AxiosError events', () => {
        init()
        const beforeSend = getBeforeSend()
        const event: Sentry.Event = { exception: { values: [{ type: 'AxiosError', value: 'network down' }] } }
        expect(beforeSend?.(event)).toBeNull()
    })

    it('still drops known noise by first value (EXECUTION_TIMEOUT, ENTITY_NOT_FOUND)', () => {
        init()
        const beforeSend = getBeforeSend()
        for (const value of ['EXECUTION_TIMEOUT', 'ENTITY_NOT_FOUND']) {
            const event: Sentry.Event = { exception: { values: [{ type: 'Error', value }] } }
            expect(beforeSend?.(event)).toBeNull()
        }
    })

    it('keeps unrelated events', () => {
        init()
        const beforeSend = getBeforeSend()
        const event: Sentry.Event = { exception: { values: [{ type: 'Error', value: 'boom' }] } }
        expect(beforeSend?.(event)).toBe(event)
    })
})
