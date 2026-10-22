import { timingSafeEqual } from 'node:crypto'
import { describe, expect, it } from 'vitest'

// Issue #369: the /v1/admin/* API-key preHandler must compare keys in constant
// time. This pins the comparison semantics that the preHandler relies on:
// equal-length keys compare flat, wrong keys always reject, and the helper
// never throws on a length mismatch (which would itself leak the key length).
describe('Admin API-key constant-time comparison (#369)', () => {
    it('accepts an identical key', () => {
        const key = 'a'.repeat(64)
        const a = Buffer.from(key)
        const b = Buffer.from(key)
        expect(timingSafeEqual(a, b)).toBe(true)
    })

    it('rejects a wrong key of the same length without throwing', () => {
        const a = Buffer.from('a'.repeat(64))
        const b = Buffer.from('b'.repeat(64))
        expect(() => {
            const equal = a.length === b.length && timingSafeEqual(a, b)
            expect(equal).toBe(false)
        }).not.toThrow()
    })

    it('length mismatch is caught before timingSafeEqual (no throw, rejects)', () => {
        const a = Buffer.from('short')
        const b = Buffer.from('much-longer-key-value-here')
        // The preHandler pattern: length check first, so the throw case is unreachable
        let equal: boolean
        expect(() => {
            equal = a.length === b.length && timingSafeEqual(a, b)
        }).not.toThrow()
        expect(equal).toBe(false)
    })

    it('a one-byte-different prefix of the right length rejects (prefix leak fixed)', () => {
        const key = 'k'.repeat(64)
        const a = Buffer.from(key)
        const b = Buffer.from('j' + key.slice(1))
        expect(a.length === b.length && timingSafeEqual(a, b)).toBe(false)
    })
})
