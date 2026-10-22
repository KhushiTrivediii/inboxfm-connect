import { describe, expect, it } from 'vitest'
import { clampRecordListLimit } from '../../../../src/app/tables/record/record.service'

describe('clampRecordListLimit (issue #400)', () => {
    it('defaults to 10 when limit is absent', () => {
        expect(clampRecordListLimit(undefined)).toBe(10)
    })

    it('clamps above MAX_PAGE_SIZE (500)', () => {
        expect(clampRecordListLimit(100000000)).toBe(500)
        expect(clampRecordListLimit(501)).toBe(500)
        // The tables piece sends this sentinel for "no limit" - it must not
        // leak an unbounded page through the service.
        expect(clampRecordListLimit(999999999)).toBe(500)
    })

    it('clamps below 1, treating 0 as absent (convention: falsy -> default)', () => {
        expect(clampRecordListLimit(0)).toBe(10)
        expect(clampRecordListLimit(-5)).toBe(1)
    })

    it('keeps in-range values and floors non-integers', () => {
        expect(clampRecordListLimit(25)).toBe(25)
        expect(clampRecordListLimit(25.7)).toBe(25)
    })

    it('falls back to the default for NaN-ish input', () => {
        expect(clampRecordListLimit(Number.NaN)).toBe(10)
    })
})
