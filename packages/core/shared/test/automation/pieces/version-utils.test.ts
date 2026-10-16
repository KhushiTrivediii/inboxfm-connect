import { describe, expect, it } from 'vitest'
import { getPieceMajorAndMinorVersion } from '../../../src/lib/automation/pieces/version-utils'

describe('getPieceMajorAndMinorVersion', () => {
    it('resolves an exact version to its major.minor pair', () => {
        expect(getPieceMajorAndMinorVersion('1.2.3')).toBe('1.2')
        expect(getPieceMajorAndMinorVersion('0.10.4')).toBe('0.10')
    })

    it('resolves ranges to their minimum satisfying version', () => {
        expect(getPieceMajorAndMinorVersion('^1.2.3')).toBe('1.2')
        expect(getPieceMajorAndMinorVersion('~2.5.0')).toBe('2.5')
        expect(getPieceMajorAndMinorVersion('>=2.0.0 <3.0.0')).toBe('2.0')
        expect(getPieceMajorAndMinorVersion('*')).toBe('0.0')
    })

    it('returns non-semver tags instead of throwing', () => {
        // Regression: semver's minVersion/major throw a TypeError for
        // dist-tags like 'latest', and the old fallback branch re-threw on
        // exactly the non-semver inputs it existed to handle.
        expect(getPieceMajorAndMinorVersion('latest')).toBe('latest')
        expect(getPieceMajorAndMinorVersion('main')).toBe('main')
        expect(getPieceMajorAndMinorVersion('not a version')).toBe('not a version')
    })

    it('treats an empty input like the any-range instead of throwing', () => {
        // semver itself resolves '' as '*', whose minimum version is 0.0.0.
        expect(getPieceMajorAndMinorVersion('')).toBe('0.0')
    })
})
