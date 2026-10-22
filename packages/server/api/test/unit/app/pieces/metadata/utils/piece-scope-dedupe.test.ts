import { describe, expect, it } from 'vitest'

// Issue #417: lastVersionOfEachPiece must dedupe by (name, platformId) scope,
// not by name alone — a platform-scoped custom piece sharing a name with an
// official piece must BOTH survive. Mirrors pickLatestVersionIds' key shape.

type PieceLike = {
    name: string
    version: string
    platformId?: string
}

const loadFn = async () => {
    const mod = await import('../../../../../../src/app/pieces/metadata/utils/piece-cache-utils')
    return mod.lastVersionOfEachPiece as (pieces: PieceLike[], platformId?: string) => PieceLike[]
}

describe('lastVersionOfEachPiece — scope-aware dedupe (issue #417)', () => {
    it('keeps BOTH the official piece and the platform-scoped custom piece when names collide', async () => {
        const lastVersionOfEachPiece = await loadFn()
        const official: PieceLike = { name: 'slack', version: '2.3.1' }
        const custom: PieceLike = { name: 'slack', version: '1.0.0', platformId: 'acme' }
        const result = lastVersionOfEachPiece([official, custom])
        expect(result).toHaveLength(2)
        expect(result.some((p) => p.platformId === undefined && p.version === '2.3.1')).toBe(true)
        expect(result.some((p) => p.platformId === 'acme' && p.version === '1.0.0')).toBe(true)
    })

    it('still dedupes same-scope duplicates, keeping the newest version', async () => {
        const lastVersionOfEachPiece = await loadFn()
        const result = lastVersionOfEachPiece([
            { name: 'slack', version: '1.0.0' },
            { name: 'slack', version: '2.0.0' },
            { name: 'slack', version: '1.5.0' },
        ])
        expect(result).toHaveLength(1)
        expect(result[0].version).toBe('2.0.0')
    })

    it('keeps the platform piece across TWO different platforms with the same name', async () => {
        const lastVersionOfEachPiece = await loadFn()
        const result = lastVersionOfEachPiece([
            { name: 'slack', version: '3.0.0', platformId: 'alpha' },
            { name: 'slack', version: '1.0.0', platformId: 'beta' },
        ])
        expect(result).toHaveLength(2)
    })

    // Review follow-up: within a platform's own view, the platform-scoped
    // piece REPLACES the same-name official — the official row must not also
    // appear in that platform's list. Other platforms and the platform-less
    // view still get the official row.
    it('drops the official row from the platform view when its scoped piece survives the dedupe', async () => {
        const lastVersionOfEachPiece = await loadFn()
        const official: PieceLike = { name: 'slack', version: '2.3.1' }
        const custom: PieceLike = { name: 'slack', version: '1.0.0', platformId: 'acme' }
        const result = lastVersionOfEachPiece([official, custom], 'acme')
        expect(result).toHaveLength(1)
        expect(result[0].platformId).toBe('acme')
        expect(result[0].version).toBe('1.0.0')
    })

    it('keeps the official row for a DIFFERENT platform than the requested one', async () => {
        const lastVersionOfEachPiece = await loadFn()
        const official: PieceLike = { name: 'slack', version: '2.3.1' }
        const custom: PieceLike = { name: 'slack', version: '1.0.0', platformId: 'acme' }
        const result = lastVersionOfEachPiece([official, custom], 'beta')
        expect(result).toHaveLength(2)
        expect(result.some((p) => p.platformId === undefined && p.version === '2.3.1')).toBe(true)
        expect(result.some((p) => p.platformId === 'acme' && p.version === '1.0.0')).toBe(true)
    })

    it('keeps the official row in the platform-less view (no platformId passed)', async () => {
        const lastVersionOfEachPiece = await loadFn()
        const official: PieceLike = { name: 'slack', version: '2.3.1' }
        const custom: PieceLike = { name: 'slack', version: '1.0.0', platformId: 'acme' }
        const result = lastVersionOfEachPiece([official, custom])
        expect(result).toHaveLength(2)
        expect(result.some((p) => p.platformId === undefined && p.version === '2.3.1')).toBe(true)
        expect(result.some((p) => p.platformId === 'acme' && p.version === '1.0.0')).toBe(true)
    })

    it('never drops the last row of a name when only the official exists, even with platformId set', async () => {
        const lastVersionOfEachPiece = await loadFn()
        const result = lastVersionOfEachPiece([{ name: 'slack', version: '2.3.1' }], 'acme')
        expect(result).toHaveLength(1)
        expect(result[0].version).toBe('2.3.1')
    })
})
