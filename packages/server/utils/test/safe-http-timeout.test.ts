import { describe, expect, it } from 'vitest'
import { safeHttp } from '../src/safe-http'

// Issue #371: createAxios must never leave the timeout unset — axios's default
// is "no timeout", which lets a stalled upstream hang request handlers forever.
// These tests pin the default and that an explicit caller value still wins.
describe('safeHttp default request timeout (#371)', () => {
    it('applies the 30s default when the caller passes no timeout', () => {
        const instance = safeHttp.createAxios()
        expect(instance.defaults.timeout).toBe(30_000)
    })

    it('keeps the caller-provided timeout (explicit value wins over the default)', () => {
        const instance = safeHttp.createAxios({ timeout: 1234 })
        expect(instance.defaults.timeout).toBe(1234)
    })

    it('applies the default alongside other caller config (baseURL merge intact)', () => {
        const instance = safeHttp.createAxios({ baseURL: 'https://example.com' })
        expect(instance.defaults.baseURL).toBe('https://example.com')
        expect(instance.defaults.timeout).toBe(30_000)
    })

    it('the retrying variant inherits the same bounded default', () => {
        const instance = safeHttp.createRetryingAxios()
        expect(instance.defaults.timeout).toBe(30_000)
    })
})
